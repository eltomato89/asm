/**
 * Standing requests: an agent (MCP main device) proposes a standing approval; the user approves (optionally narrowed)
 * or denies it. Never auto-approved; approving needs a recent sign-in (app) or a passkey with UV (push) — enforced by callers.
 *
 * Error codes (HttpError; `details` keys are snake_case strings):
 * - create: 403 standing_request_mcp_only (not an unlinked 'mcp' device) | 409 device_inactive | 403 standing_requests_disabled
 *   | 409 standing_active | 409 standing_request_pending {request_id} | 429 standing_request_cooldown {retry_after: ISO 8601}
 *   | 429 standing_request_limit {retry_after: ISO 8601} | 400 invalid_request (shape: scope 'all', extra keys such as
 *   allowUpdates/includeCreated) | 400 empty_list | 400 invalid_days | 400 invalid_renew_days | 404 vault_not_found
 *   | 404 secret_not_found | 409 secret_archived
 * - decide: 404 not_found (unknown / not the owner) | 410 expired | 409 already_decided (approved/denied/cancelled)
 *   | approve only: 409 device_inactive (cancelled, cause device_revoked) | 403 standing_requests_disabled (cancelled,
 *   cause disabled_by_admin) | 409 standing_active (cancelled, cause superseded) | 400 not_narrower | 400 invalid_days
 *   | 400 invalid_renew_days (limits lowered since the proposal) | 400 empty_list | 409 items_unavailable (nothing left)
 */
import {
  DecisionSchema,
  newId,
  ProjectNameSchema,
  ReasonSchema,
  StandingNarrowInputSchema,
  StandingProposalSchema,
  type StandingNarrowInput,
  type StandingProposal,
  type StandingRequestDiff,
  type StandingRequestDto,
  type StandingRequestItems,
} from '@asm/shared';
import { appendAudit } from '../audit/audit.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { StandingRequestDecisionRecord } from '../db/schema.js';
import { attachedClis } from '../devices/links.js';
import { HttpError } from '../errors.js';
import type { DeviceIdentity } from '../oauth/bearer.js';
import { touchProject } from '../projects/service.js';
import { canAccessVault } from '../vaults/service.js';
import { DAY_MS, emitDeviceChanged, hasActiveStanding, writeStandingApproval } from './service.js';

/** A proposal stays pending for 30 minutes. */
export const STANDING_REQUEST_TTL_MS = 30 * 60_000;
/** No new proposal within 24 h of a denial. */
export const STANDING_REQUEST_COOLDOWN_MS = 24 * 3600_000;
/** At most this many proposals per device within 24 h. */
export const MAX_PROPOSALS_PER_DAY = 3;
/** Window of MAX_PROPOSALS_PER_DAY. */
const LIMIT_WINDOW_MS = 24 * 3600_000;
const MAX_WAIT_MS = 60_000;
const MAX_WAITERS_PER_DEVICE = 20;
const LIST_LIMIT = 100;
/** renewDays stored for afterExpiry 'ask' (unused unless the user later switches to renew in the regular dialog). */
const DEFAULT_RENEW_DAYS = 7;

export type StandingRequestCreateInput = StandingProposal & { project: string; reason: string };

export type StandingRequestCancelCause = 'device_revoked' | 'superseded' | 'disabled_by_admin';

export type StandingRequestEligibility = {
  allowed: boolean;
  /** Why a proposal is not allowed right now (absent when allowed). */
  reason?: 'disabled' | 'active' | 'pending' | 'cooldown' | 'limit';
  /** Id of the open proposal (reason 'pending'). */
  pendingId?: string;
  /** Epoch ms from which a new proposal is possible (reason 'cooldown' | 'limit'). */
  retryAfter?: number;
  /** ctx.standingRequestMaxDays (0 = disabled). */
  maxDays: number;
};

// ---------- rows & DTO ----------

type Row = {
  id: string; user_id: string; device_id: string; scope: 'vaults' | 'list'; vault_ids: string; secret_ids: string; days: number;
  after_expiry: 'ask' | 'renew'; renew_days: number | null; project: string; reason: string;
  status: StandingRequestDto['status']; decided_by: string | null; decided_at: number | null; decision: string | null;
  cause: string | null; created_at: number; expires_at: number;
  device_name: string; device_kind: 'mcp' | 'cli'; device_status: string; decided_by_name: string | null;
};

const SELECT = `
  SELECT r.*, d.name AS device_name, d.kind AS device_kind, d.status AS device_status, u.username AS decided_by_name
    FROM standing_requests r
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN users u ON u.id = r.decided_by`;

function loadRow(ctx: ServiceCtx, id: string): Row | undefined {
  return ctx.db.$client.prepare(`${SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
}

/** Both caps on: proposals enabled. */
function enabled(ctx: ServiceCtx): boolean {
  return ctx.standingRequestMaxDays > 0 && ctx.standingMaxDays > 0;
}

/** Current upper bound for proposed days / renewDays (0 = disabled). */
function maxDays(ctx: ServiceCtx): number {
  return enabled(ctx) ? Math.min(ctx.standingRequestMaxDays, ctx.standingMaxDays) : 0;
}

const dedupe = (ids: string[]) => [...new Set(ids)];

/** Canonical form: only the scope's id list (deduped), renewDays null unless afterExpiry 'renew'. */
function normalize(p: StandingProposal): StandingProposal {
  return {
    scope: p.scope,
    vaultIds: p.scope === 'vaults' ? dedupe(p.vaultIds) : [],
    secretIds: p.scope === 'list' ? dedupe(p.secretIds) : [],
    days: p.days,
    afterExpiry: p.afterExpiry,
    renewDays: p.afterExpiry === 'renew' ? p.renewDays : null,
  };
}

function proposalOf(r: Row): StandingProposal {
  return {
    scope: r.scope,
    vaultIds: JSON.parse(r.vault_ids) as string[],
    secretIds: JSON.parse(r.secret_ids) as string[],
    days: r.days,
    afterExpiry: r.after_expiry,
    renewDays: r.renew_days,
  };
}

/** Proposed items with live availability (owner still has access; secret exists and is not archived). */
function itemsOf(ctx: ServiceCtx, userId: string, p: StandingProposal): StandingRequestItems {
  const vaultQ = ctx.db.$client.prepare('SELECT name, personal_of_user_id IS NOT NULL AS personal FROM vaults WHERE id = ?');
  const vaults = p.vaultIds.map((id) => {
    const v = vaultQ.get(id) as { name: string; personal: number } | undefined;
    const available = !!v && canAccessVault(ctx.db, userId, id);
    // Names only while the owner can still see the vault.
    return { id, name: available ? v.name : '', personal: available ? v.personal === 1 : false, available };
  });
  const secretQ = ctx.db.$client.prepare(
    `SELECT s.title, s.env_name, s.archived_at, s.vault_id, v.name AS vault_name
       FROM secrets s JOIN vaults v ON v.id = s.vault_id WHERE s.id = ?`,
  );
  const secrets = p.secretIds.map((id) => {
    const s = secretQ.get(id) as { title: string; env_name: string | null; archived_at: number | null; vault_id: string; vault_name: string } | undefined;
    const visible = !!s && canAccessVault(ctx.db, userId, s.vault_id);
    return {
      id,
      title: visible ? s.title : '',
      envName: visible ? s.env_name : null,
      vaultName: visible ? s.vault_name : '',
      available: visible && s.archived_at === null,
    };
  });
  return { vaults, secrets };
}

function toDto(ctx: ServiceCtx, r: Row): StandingRequestDto {
  const proposal = proposalOf(r);
  const decision = r.decision ? (JSON.parse(r.decision) as StandingRequestDecisionRecord) : null;
  return {
    id: r.id,
    status: r.status,
    device: { id: r.device_id, name: r.device_name, kind: r.device_kind },
    attachedCli: attachedClis(ctx.db, r.device_id).map((c) => ({ name: c.name, hostname: c.hostname })),
    project: r.project,
    reason: r.reason,
    proposal,
    items: itemsOf(ctx, r.user_id, proposal),
    limits: { maxDays: maxDays(ctx) },
    final: decision?.final ?? null,
    adjusted: decision ? Object.keys(decision.diff).length > 0 : false,
    cause: r.cause,
    decidedBy: r.decided_by_name ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
  };
}

/** 404 not_found if unknown. No ownership check (callers check the user / device). */
export function getStandingRequestDto(ctx: ServiceCtx, id: string): StandingRequestDto {
  const row = loadRow(ctx, id);
  if (!row) throw new HttpError(404, 'not_found');
  return toDto(ctx, row);
}

/** The user's proposals, newest first, max 100. `pending` hides overdue-but-unswept ones. */
export function listStandingRequests(ctx: ServiceCtx, userId: string, status: 'pending' | 'all'): StandingRequestDto[] {
  const pendingOnly = status === 'pending' ? `AND r.status = 'pending' AND r.expires_at > @now` : '';
  const rows = ctx.db.$client
    .prepare(`${SELECT} WHERE r.user_id = @userId ${pendingOnly} ORDER BY r.created_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`)
    .all({ userId, now: ctx.clock.now() }) as Row[];
  return rows.map((r) => toDto(ctx, r));
}

// ---------- events ----------

function emit(ctx: ServiceCtx, type: 'standing_request.created' | 'standing_request.updated', id: string): void {
  try {
    const row = loadRow(ctx, id);
    if (row) ctx.events.emit(row.user_id, { type, data: toDto(ctx, row) });
  } catch (err) {
    ctx.logger?.error({ errName: (err as Error).name }, 'standing request event emission failed');
  }
}

/** For code running inside a caller's transaction: emit the then-current state once the transaction has finished. */
function emitAfterCommit(ctx: ServiceCtx, id: string): void {
  queueMicrotask(() => emit(ctx, 'standing_request.updated', id));
}

// ---------- eligibility ----------

export function standingRequestEligibility(ctx: ServiceCtx, deviceId: string): StandingRequestEligibility {
  const max = maxDays(ctx);
  if (max <= 0) return { allowed: false, reason: 'disabled', maxDays: 0 };
  if (hasActiveStanding(ctx, deviceId)) return { allowed: false, reason: 'active', maxDays: max };
  const { db } = ctx;
  const now = ctx.clock.now();
  const pending = db.$client
    .prepare(`SELECT id FROM standing_requests WHERE device_id = ? AND status = 'pending' AND expires_at > ?`)
    .get(deviceId, now) as { id: string } | undefined;
  if (pending) return { allowed: false, reason: 'pending', pendingId: pending.id, maxDays: max };
  const denied = db.$client
    .prepare(`SELECT max(decided_at) AS at FROM standing_requests WHERE device_id = ? AND status = 'denied' AND decided_at > ?`)
    .get(deviceId, now - STANDING_REQUEST_COOLDOWN_MS) as { at: number | null };
  if (denied.at !== null) return { allowed: false, reason: 'cooldown', retryAfter: denied.at + STANDING_REQUEST_COOLDOWN_MS, maxDays: max };
  const recent = db.$client
    .prepare('SELECT created_at FROM standing_requests WHERE device_id = ? AND created_at > ? ORDER BY created_at')
    .all(deviceId, now - LIMIT_WINDOW_MS) as { created_at: number }[];
  if (recent.length >= MAX_PROPOSALS_PER_DAY) {
    // A slot frees up once enough of the oldest proposals in the window have aged out.
    const retryAfter = recent[recent.length - MAX_PROPOSALS_PER_DAY]!.created_at + LIMIT_WINDOW_MS;
    return { allowed: false, reason: 'limit', retryAfter, maxDays: max };
  }
  return { allowed: true, maxDays: max };
}

function eligibilityError(el: StandingRequestEligibility): HttpError {
  const iso = (ms: number | undefined) => new Date(ms ?? 0).toISOString();
  switch (el.reason) {
    case 'disabled': return new HttpError(403, 'standing_requests_disabled');
    case 'active': return new HttpError(409, 'standing_active');
    case 'pending': return new HttpError(409, 'standing_request_pending', undefined, { request_id: el.pendingId ?? '' });
    case 'cooldown': return new HttpError(429, 'standing_request_cooldown', undefined, { retry_after: iso(el.retryAfter) });
    default: return new HttpError(429, 'standing_request_limit', undefined, { retry_after: iso(el.retryAfter) });
  }
}

// ---------- create ----------

/** Range checks shared by create and decide (current limits). */
function checkRanges(ctx: ServiceCtx, p: StandingProposal): void {
  const max = maxDays(ctx);
  if (!(p.days >= 1 && p.days <= max)) throw new HttpError(400, 'invalid_days');
  if (p.afterExpiry === 'renew' && !(p.renewDays !== null && p.renewDays >= 1 && p.renewDays <= max)) {
    throw new HttpError(400, 'invalid_renew_days');
  }
  if ((p.scope === 'vaults' ? p.vaultIds : p.secretIds).length === 0) throw new HttpError(400, 'empty_list');
}

/** Pending proposals of the device past expires_at → expired (inside the caller's transaction). Returns their ids. */
function expireOverdue(ctx: ServiceCtx, rows: Row[]): string[] {
  const now = ctx.clock.now();
  const out: string[] = [];
  const upd = ctx.db.$client.prepare(
    `UPDATE standing_requests SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
  );
  for (const r of rows) {
    if (upd.run(now, r.id, now).changes === 0) continue;
    appendAudit(ctx.db, ctx.clock, {
      actorType: 'system', actorId: null, event: 'standing_request.expired', deviceId: r.device_id, project: r.project,
      meta: { requestId: r.id },
    });
    out.push(r.id);
  }
  return out;
}

/** Creates a pending proposal for `device` (must be an approved, unlinked 'mcp' device; checks eligibility + validation). */
export function createStandingRequest(
  ctx: ServiceCtx,
  device: DeviceIdentity,
  input: StandingRequestCreateInput,
  info: RequestInfo = {},
): StandingRequestDto {
  const projectName = ProjectNameSchema.parse(input.project);
  const reason = ReasonSchema.parse(input.reason);
  const { project: _project, reason: _reason, ...rest } = input;
  const proposal = normalize(StandingProposalSchema.parse(rest));
  const { db } = ctx;
  const id = newId('srq');
  const expired = db.$client.transaction((): string[] => {
    const dev = db.$client
      .prepare('SELECT user_id, kind, status, linked_to_device_id FROM devices WHERE id = ?')
      .get(device.id) as { user_id: string | null; kind: string; status: string; linked_to_device_id: string | null } | undefined;
    if (!dev || dev.user_id !== device.userId) throw new HttpError(404, 'not_found');
    if (dev.kind !== 'mcp' || dev.linked_to_device_id !== null) throw new HttpError(403, 'standing_request_mcp_only');
    if (dev.status !== 'approved') throw new HttpError(409, 'device_inactive');
    const now = ctx.clock.now();
    // An overdue (not yet swept) proposal would block the one-pending index.
    const overdue = expireOverdue(
      ctx,
      db.$client.prepare(`${SELECT} WHERE r.device_id = ? AND r.status = 'pending' AND r.expires_at <= ?`).all(device.id, now) as Row[],
    );
    const el = standingRequestEligibility(ctx, device.id);
    if (!el.allowed) throw eligibilityError(el);
    checkRanges(ctx, proposal);
    for (const vid of proposal.vaultIds) if (!canAccessVault(db, device.userId, vid)) throw new HttpError(404, 'vault_not_found');
    const secretQ = db.$client.prepare(
      'SELECT s.archived_at FROM secrets s JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = ? WHERE s.id = ?',
    );
    for (const sid of proposal.secretIds) {
      const s = secretQ.get(device.userId, sid) as { archived_at: number | null } | undefined;
      if (!s) throw new HttpError(404, 'secret_not_found');
      if (s.archived_at !== null) throw new HttpError(409, 'secret_archived');
    }
    const project = touchProject(ctx, projectName);
    db.$client
      .prepare(
        `INSERT INTO standing_requests (id, user_id, device_id, scope, vault_ids, secret_ids, days, after_expiry, renew_days, project,
                                        reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id, device.userId, device.id, proposal.scope, JSON.stringify(proposal.vaultIds), JSON.stringify(proposal.secretIds), proposal.days,
        proposal.afterExpiry, proposal.renewDays, project.slug, reason, now, now + STANDING_REQUEST_TTL_MS,
      );
    appendAudit(db, ctx.clock, {
      actorType: 'device', actorId: device.id, event: 'standing_request.created', deviceId: device.id, project: project.slug, reason,
      ip: info.ip,
      meta: {
        requestId: id, scope: proposal.scope, vaultIds: proposal.vaultIds, secretIds: proposal.secretIds, days: proposal.days,
        afterExpiry: proposal.afterExpiry, renewDays: proposal.renewDays,
      },
    });
    return overdue;
  })();
  for (const e of expired) emit(ctx, 'standing_request.updated', e);
  emit(ctx, 'standing_request.created', id);
  try {
    ctx.hooks.onStandingRequestPending(ctx, id);
  } catch (err) {
    ctx.logger?.error({ errName: (err as Error).name }, 'pending standing request hook failed');
  }
  return getStandingRequestDto(ctx, id);
}

// ---------- decide ----------

/** What the user changed relative to the proposal ({} = unchanged). */
export function standingRequestDiff(proposal: StandingProposal, final: StandingProposal): StandingRequestDiff {
  const diff: StandingRequestDiff = {};
  if (proposal.days !== final.days) diff.days = { from: proposal.days, to: final.days };
  const removedVaultIds = proposal.vaultIds.filter((id) => !final.vaultIds.includes(id));
  if (removedVaultIds.length > 0) diff.removedVaultIds = removedVaultIds;
  const removedSecretIds = proposal.secretIds.filter((id) => !final.secretIds.includes(id));
  if (removedSecretIds.length > 0) diff.removedSecretIds = removedSecretIds;
  if (proposal.afterExpiry !== final.afterExpiry) diff.afterExpiry = { from: proposal.afterExpiry, to: final.afterExpiry };
  if (proposal.renewDays !== final.renewDays) diff.renewDays = { from: proposal.renewDays, to: final.renewDays };
  return diff;
}

/** `chosen` may only narrow `proposal` (same scope, subset of ids, fewer days, renew → ask, fewer renew days); else 400 not_narrower. */
function assertNarrower(proposal: StandingProposal, chosen: StandingProposal): void {
  const subset = (a: string[], b: string[]) => a.every((id) => b.includes(id));
  const ok =
    chosen.scope === proposal.scope &&
    subset(chosen.vaultIds, proposal.vaultIds) &&
    subset(chosen.secretIds, proposal.secretIds) &&
    chosen.days <= proposal.days &&
    (chosen.afterExpiry === 'ask' ||
      (proposal.afterExpiry === 'renew' &&
        chosen.renewDays !== null &&
        proposal.renewDays !== null &&
        chosen.renewDays <= proposal.renewDays));
  if (!ok) throw new HttpError(400, 'not_narrower');
}

/** pending → cancelled (inside the caller's transaction, no event). */
function cancelRow(ctx: ServiceCtx, r: Pick<Row, 'id' | 'device_id' | 'project'>, cause: StandingRequestCancelCause): boolean {
  const res = ctx.db.$client
    .prepare(`UPDATE standing_requests SET status = 'cancelled', cause = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(cause, ctx.clock.now(), r.id);
  if (res.changes === 0) return false;
  appendAudit(ctx.db, ctx.clock, {
    actorType: 'system', actorId: null, event: 'standing_request.cancelled', deviceId: r.device_id, project: r.project,
    meta: { requestId: r.id, cause },
  });
  return true;
}

/**
 * Owner decides. Approve: `settings` (optional) must be a narrowing of the proposal (else 400 not_narrower); writes the
 * standing approval via writeStandingApproval with origin {agent_request, proposed, diff} in the same transaction.
 * Items that are no longer available (vault access lost, secret archived/deleted) are dropped (recorded in the diff); if none
 * is left: 409 items_unavailable. Callers (routes) require recent sign-in (app) or passkey UV (push) for approve; deny needs
 * neither (`settings` is ignored on deny). Error codes: see the module comment.
 */
export function decideStandingRequest(
  ctx: ServiceCtx,
  input: { id: string; userId: string; decision: 'approve' | 'deny'; settings?: StandingNarrowInput },
  info: RequestInfo = {},
  /** Extra audit meta for the decision entry (e.g. `{ via: 'push' }`); never values. */
  auditMeta: Record<string, string> = {},
): StandingRequestDto {
  const { db } = ctx;
  const decision = DecisionSchema.parse(input.decision);
  const settings =
    decision === 'approve' && input.settings !== undefined ? normalize(StandingNarrowInputSchema.parse(input.settings)) : undefined;
  const first = loadRow(ctx, input.id);
  if (!first || first.user_id !== input.userId) throw new HttpError(404, 'not_found');
  const via = auditMeta.via ?? 'web';

  const result = db.$client.transaction((): { error: HttpError | null; approved: boolean } => {
    const row = loadRow(ctx, input.id)!;
    const now = ctx.clock.now();
    if (row.status === 'expired' || (row.status === 'pending' && row.expires_at <= now)) throw new HttpError(410, 'expired');
    if (row.status !== 'pending') throw new HttpError(409, 'already_decided');
    const common = { deviceId: row.device_id, project: row.project, reason: row.reason, ip: info.ip };

    if (decision === 'deny') {
      db.$client
        .prepare(`UPDATE standing_requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?`)
        .run(input.userId, now, row.id);
      appendAudit(db, ctx.clock, {
        actorType: 'user', actorId: input.userId, event: 'standing_request.denied', ...common,
        meta: { ...auditMeta, requestId: row.id, via },
      });
      return { error: null, approved: false };
    }

    // Preconditions whose failure ends the proposal on behalf of the system (committed, then the error is thrown).
    if (row.device_status !== 'approved') {
      cancelRow(ctx, row, 'device_revoked');
      return { error: new HttpError(409, 'device_inactive'), approved: false };
    }
    if (!enabled(ctx)) {
      cancelRow(ctx, row, 'disabled_by_admin');
      return { error: new HttpError(403, 'standing_requests_disabled'), approved: false };
    }
    if (hasActiveStanding(ctx, row.device_id)) {
      cancelRow(ctx, row, 'superseded');
      return { error: new HttpError(409, 'standing_active'), approved: false };
    }

    const proposal = proposalOf(row);
    const chosen = settings ?? proposal;
    assertNarrower(proposal, chosen);
    checkRanges(ctx, chosen);
    const items = itemsOf(ctx, row.user_id, proposal);
    const availVaults = new Set(items.vaults.filter((v) => v.available).map((v) => v.id));
    const availSecrets = new Set(items.secrets.filter((s) => s.available).map((s) => s.id));
    const final: StandingProposal = {
      ...chosen,
      vaultIds: chosen.vaultIds.filter((id) => availVaults.has(id)),
      secretIds: chosen.secretIds.filter((id) => availSecrets.has(id)),
    };
    if ((final.scope === 'vaults' ? final.vaultIds : final.secretIds).length === 0) throw new HttpError(409, 'items_unavailable');
    const diff = standingRequestDiff(proposal, final);

    writeStandingApproval(
      ctx, row.user_id, row.device_id,
      {
        until: now + final.days * DAY_MS, scope: final.scope, vaultIds: final.vaultIds, secretIds: final.secretIds,
        includeCreated: false, allowUpdates: false, afterExpiry: final.afterExpiry,
        renewDays: final.renewDays ?? Math.min(DEFAULT_RENEW_DAYS, ctx.standingMaxDays),
      },
      info,
      { type: 'agent_request', requestId: row.id, proposed: proposal, diff },
    );
    const record: StandingRequestDecisionRecord = { final, diff };
    db.$client
      .prepare(`UPDATE standing_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision = ? WHERE id = ?`)
      .run(input.userId, now, JSON.stringify(record), row.id);
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: input.userId, event: 'standing_request.approved', ...common,
      meta: { ...auditMeta, requestId: row.id, via, adjusted: Object.keys(diff).length > 0, diff, final },
    });
    return { error: null, approved: true };
  })();

  emit(ctx, 'standing_request.updated', input.id);
  emitDeviceChanged(ctx, first.user_id, first.device_id);
  if (result.error) throw result.error;
  return getStandingRequestDto(ctx, input.id);
}

// ---------- wait ----------

const waiters = new Map<string, number>();
const abortError = () => new DOMException('The operation was aborted', 'AbortError');

/**
 * Long-poll for the proposing device (await_request with an srq_ id): resolves once decided/ended or on timeout (clamped to
 * 0…60 000 ms) with the current state. Only the proposing device may wait (else 404 not_found); 429 too_many_waiters.
 */
export function waitForStandingRequest(
  ctx: ServiceCtx,
  id: string,
  deviceId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StandingRequestDto> {
  const row = ctx.db.$client.prepare('SELECT device_id, user_id FROM standing_requests WHERE id = ?').get(id) as
    | { device_id: string; user_id: string }
    | undefined;
  if (!row || row.device_id !== deviceId) return Promise.reject(new HttpError(404, 'not_found'));
  const timeout = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), MAX_WAIT_MS);
  if (signal?.aborted) return Promise.reject(abortError());
  const active = waiters.get(deviceId) ?? 0;
  if (active >= MAX_WAITERS_PER_DEVICE) return Promise.reject(new HttpError(429, 'too_many_waiters'));
  waiters.set(deviceId, active + 1);

  return new Promise<StandingRequestDto>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const n = (waiters.get(deviceId) ?? 1) - 1;
      if (n <= 0) waiters.delete(deviceId);
      else waiters.set(deviceId, n);
    };
    const finish = (snapshot?: StandingRequestDto) => {
      if (settled) return;
      cleanup();
      try {
        resolve(getStandingRequestDto(ctx, id));
      } catch (err) {
        if (snapshot) resolve(snapshot);
        else reject(err);
      }
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Subscribe before checking the status so no transition is missed.
    const unsubscribe = ctx.events.subscribe(row.user_id, (e) => {
      if ((e.type === 'standing_request.created' || e.type === 'standing_request.updated') && e.data.id === id && e.data.status !== 'pending') {
        finish(e.data);
      }
    });
    timer = setTimeout(() => finish(), timeout);
    const cur = ctx.db.$client.prepare('SELECT status FROM standing_requests WHERE id = ?').get(id) as { status: string } | undefined;
    if (!cur || cur.status !== 'pending') finish();
  });
}

// ---------- sweep & hooks ----------

/**
 * Cancels every pending proposal (audit standing_request.cancelled with `cause`, events). Own transaction. Used when the admin
 * turned proposals off (either max days 0): on startup and by the sweep.
 */
export function cancelAllStandingRequests(ctx: ServiceCtx, cause: StandingRequestCancelCause): void {
  const rows = ctx.db.$client.prepare(`${SELECT} WHERE r.status = 'pending'`).all() as Row[];
  if (rows.length === 0) return;
  const changed = ctx.db.$client.transaction(() => rows.filter((r) => cancelRow(ctx, r, cause)).map((r) => r.id))();
  for (const id of changed) emit(ctx, 'standing_request.updated', id);
}

/**
 * Sweep: pending proposals past expires_at → expired (audit standing_request.expired, event). While proposals are disabled
 * (either max days 0) all pending ones are cancelled instead (cause disabled_by_admin).
 */
export function expireStandingRequests(ctx: ServiceCtx): void {
  if (!enabled(ctx)) cancelAllStandingRequests(ctx, 'disabled_by_admin');
  const due = ctx.db.$client
    .prepare(`${SELECT} WHERE r.status = 'pending' AND r.expires_at <= ?`)
    .all(ctx.clock.now()) as Row[];
  if (due.length === 0) return;
  const expired = ctx.db.$client.transaction(() => expireOverdue(ctx, due))();
  for (const id of expired) emit(ctx, 'standing_request.updated', id);
}

/** Cancels the device's pending proposal (audit standing_request.cancelled with `cause`, event). Runs in caller's txn. */
export function cancelStandingRequestsForDevice(ctx: ServiceCtx, deviceId: string, cause: StandingRequestCancelCause): void {
  const rows = ctx.db.$client
    .prepare(`SELECT id, device_id, project FROM standing_requests WHERE device_id = ? AND status = 'pending'`)
    .all(deviceId) as Pick<Row, 'id' | 'device_id' | 'project'>[];
  for (const r of rows) if (cancelRow(ctx, r, cause)) emitAfterCommit(ctx, r.id);
}
