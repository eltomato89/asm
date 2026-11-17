import {
  DecisionSchema,
  DeliverySchema,
  GenerateSchema,
  newId,
  ProjectNameSchema,
  ReasonSchema,
  SecretInputSchema,
  SecretValueSchema,
  type AccessRequestDto,
  type RequestMetaDiff,
  type SecretInput,
} from '@asm/shared';
import { appendAudit } from '../audit/audit.js';
import type { Actor, RequestInfo, ServiceCtx, ServiceHooks } from '../context.js';
import { open, seal, type Sealed } from '../crypto/envelope.js';
import type { Db } from '../db/client.js';
import type { MetaSnapshot } from '../db/schema.js';
import { ZodError } from 'zod';
import { HttpError, ValidationError } from '../errors.js';
import type { DeviceIdentity } from '../oauth/bearer.js';
import { recordUsage, touchProject } from '../projects/service.js';
import { applySecretChange, generateValue, loadAccessible, same, SNAPSHOT_FIELDS, type GenerateSpec } from '../secrets/service.js';
import {
  emitDeviceChanged,
  expireStandingApprovals,
  removeForLostVault,
  renewalDays,
  renewOnApproval,
  standingCoverage,
} from '../standing/service.js';
import { canAccessVault } from '../vaults/service.js';
import { expireAutoModes, isAutoApproved } from './automode.js';
import type { RequestEvent } from './events.js';
import { issueGrant, type Delivery } from './grants.js';

export const REQUEST_TTL_MS = 5 * 60_000;
export const MAX_WAIT_MS = 60_000;
const LIST_LIMIT = 100;
const SYSTEM = 'system';

export type RequestStatus = AccessRequestDto['status'];
export type SystemCause = 'archived' | 'member_removed' | 'device_inactive' | 'plaintext_disabled' | 'deleted' | 'device_link_changed';
export const MAX_WAITERS_PER_DEVICE = 20;

/** Raised inside a decision transaction when applying an approved update fails (carries the error code only). */
class ApplyFailed extends Error {
  constructor(readonly errorCode: string) {
    super('apply_failed');
    this.name = 'ApplyFailed';
  }
}

/** Expected domain errors become ApplyFailed; anything else (bugs, decrypt failures) propagates unchanged. */
function applyOrFail(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError || err instanceof ValidationError) throw new ApplyFailed(err.code);
    if (err instanceof ZodError) throw new ApplyFailed('invalid_request');
    throw err;
  }
}

/** pending → denied after a failed apply (cause 'apply_failed'); decidedBy = approver user id or 'system' (auto). */
function denyApplyFailed(
  ctx: ServiceCtx, r: RequestRow, decidedBy: string, errorCode: string, info: RequestInfo, auditMeta: Record<string, string> = {},
): boolean {
  const res = ctx.db.$client
    .prepare(
      `UPDATE access_requests SET status = 'denied', decided_by = ?, decided_at = ?, proposed_value_sealed = NULL
        WHERE id = ? AND status = 'pending'`,
    )
    .run(decidedBy, ctx.clock.now(), r.id);
  if (res.changes === 0) return false;
  const system = decidedBy === SYSTEM;
  appendAudit(ctx.db, ctx.clock, {
    actorType: system ? 'system' : 'user', actorId: system ? null : decidedBy, event: 'request.denied',
    secretId: r.secret_id, vaultId: r.vault_id, deviceId: r.device_id, project: r.project, reason: r.reason, ip: system ? undefined : info.ip,
    meta: { ...auditMeta, requestId: r.id, kind: r.kind, cause: 'apply_failed', error: errorCode },
  });
  return true;
}

/** Stored in access_requests.proposed_meta for update requests (no values). */
type ProposedMeta = { diff: RequestMetaDiff; valueChanged: boolean; baseVersion?: number };

// ---------- rows & DTO ----------

type RequestRow = {
  id: string; kind: 'read' | 'update'; secret_id: string; device_id: string; user_id: string; project: string; reason: string;
  delivery: Delivery | null; proposed_meta: string | null; proposed_value_sealed: string | null; status: RequestStatus;
  decided_by: string | null; auto: number; auto_source: 'automode' | 'standing' | null; standing_renewal: number; created_at: number; decided_at: number | null; expires_at: number;
  title: string; env_name: string | null; vault_id: string; vault_name: string;
  device_name: string; device_kind: 'mcp' | 'cli'; device_status: string; decided_by_name: string | null;
  allow_plaintext_to_agent: number; current_version: number;
  /** The standing approval that applies to the device (its main device's for an attached CLI; LEFT JOIN; null if none). */
  sa_until: number | null; sa_granted_at: number | null; sa_after_expiry: 'ask' | 'renew' | null; sa_renew_days: number | null;
};

const REQUEST_SELECT = `
  SELECT r.*, s.title, s.env_name, s.vault_id, v.name AS vault_name, s.allow_plaintext_to_agent, s.current_version,
         d.name AS device_name, d.kind AS device_kind, d.status AS device_status, u.username AS decided_by_name,
         sa.until AS sa_until, sa.granted_at AS sa_granted_at, sa.after_expiry AS sa_after_expiry, sa.renew_days AS sa_renew_days
    FROM access_requests r
    JOIN secrets s ON s.id = r.secret_id
    JOIN vaults v ON v.id = s.vault_id
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN users u ON u.id = r.decided_by
    LEFT JOIN standing_approvals sa ON sa.device_id = COALESCE(d.linked_to_device_id, d.id)`;

function loadRow(db: Db, requestId: string): RequestRow | undefined {
  return db.$client.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(requestId) as RequestRow | undefined;
}

/** Whether approving this renewal request now would extend the device's standing approval (coverage re-checked). */
function renewsNow(ctx: ServiceCtx, r: RequestRow): boolean {
  return (
    r.standing_renewal === 1 &&
    standingCoverage(ctx, { deviceId: r.device_id, userId: r.user_id, secretId: r.secret_id, vaultId: r.vault_id, kind: r.kind }) ===
      'renewal'
  );
}

/**
 * For the dashboard decision route: whether approving `requestId` as `userId` would currently renew a standing approval
 * (then recent auth is required). False for unknown/foreign/decided requests (decideRequest reports those).
 */
export function approvalWouldRenew(ctx: ServiceCtx, requestId: string, userId: string): boolean {
  const row = loadRow(ctx.db, requestId);
  return !!row && row.user_id === userId && row.status === 'pending' && renewsNow(ctx, row);
}

/** Pending renewal request whose approval would currently extend the device's standing approval. */
function renewalOf(ctx: ServiceCtx, r: RequestRow): AccessRequestDto['renewal'] {
  if (r.standing_renewal !== 1 || r.status !== 'pending' || r.sa_until === null || !renewsNow(ctx, r)) return null;
  const days = renewalDays(ctx, {
    until: r.sa_until, granted_at: r.sa_granted_at!, after_expiry: r.sa_after_expiry!, renew_days: r.sa_renew_days!,
  });
  return days === null ? null : { days };
}

function toDto(ctx: ServiceCtx, r: RequestRow): AccessRequestDto {
  const dto: AccessRequestDto = {
    id: r.id,
    kind: r.kind,
    status: r.status,
    secret: { id: r.secret_id, title: r.title, envName: r.env_name, vaultId: r.vault_id, vaultName: r.vault_name },
    device: { id: r.device_id, name: r.device_name, kind: r.device_kind },
    project: r.project,
    reason: r.reason,
    delivery: r.delivery,
    auto: r.auto === 1,
    decidedBy:
      r.decided_by === null
        ? null
        : r.decided_by === SYSTEM
          ? { type: 'system', id: null, name: null }
          : { type: 'user', id: r.decided_by, name: r.decided_by_name },
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
    autoSource: r.auto_source ?? (r.auto === 1 ? 'automode' : null),
    renewal: renewalOf(ctx, r),
  };
  if (r.kind === 'update') {
    const pm = r.proposed_meta ? (JSON.parse(r.proposed_meta) as ProposedMeta) : { diff: {}, valueChanged: false };
    dto.metaDiff = pm.diff;
    dto.valueChanged = pm.valueChanged;
  }
  return dto;
}

export function getRequestDto(ctx: ServiceCtx, requestId: string): AccessRequestDto {
  const row = loadRow(ctx.db, requestId);
  if (!row) throw new HttpError(404, 'not_found');
  return toDto(ctx, row);
}

/** The user's own requests (as device owner), newest first, max 100. `pending` hides overdue-but-unswept ones. */
export function listRequests(ctx: ServiceCtx, userId: string, status: 'pending' | 'all' = 'pending'): AccessRequestDto[] {
  const pendingOnly = status === 'pending' ? `AND r.status = 'pending' AND r.expires_at > @now` : '';
  const rows = ctx.db.$client
    .prepare(`${REQUEST_SELECT} WHERE r.user_id = @userId ${pendingOnly} ORDER BY r.created_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`)
    .all({ userId, now: ctx.clock.now() }) as RequestRow[];
  return rows.map((r) => toDto(ctx, r));
}

// ---------- events ----------

function emitRequest(ctx: ServiceCtx, type: 'request.created' | 'request.updated', requestId: string): void {
  const row = loadRow(ctx.db, requestId);
  if (!row) return;
  const event: RequestEvent = { type, data: toDto(ctx, row) };
  ctx.events.emit(row.user_id, event);
}

/** Runs `emit` once the caller's synchronous transaction has finished; failures are logged, never thrown. */
function afterCommit(ctx: ServiceCtx, emit: () => void): void {
  queueMicrotask(() => {
    try {
      emit();
    } catch (err) {
      ctx.logger?.error({ errName: (err as Error).name }, 'request event emission failed');
    }
  });
}

/** For hooks running inside a caller's transaction: emit (current state) once the transaction has finished. */
function emitAfterCommit(ctx: ServiceCtx, requestIds: string[]): void {
  for (const id of requestIds) afterCommit(ctx, () => emitRequest(ctx, 'request.updated', id));
}

/** Like emitAfterCommit, but snapshots the DTOs now (for rows the caller's transaction deletes, e.g. by cascade). */
function emitSnapshotsAfterCommit(ctx: ServiceCtx, requestIds: string[]): void {
  for (const id of requestIds) {
    const row = loadRow(ctx.db, id);
    if (!row) continue;
    const event: RequestEvent = { type: 'request.updated', data: toDto(ctx, row) };
    afterCommit(ctx, () => ctx.events.emit(row.user_id, event));
  }
}

/** Hands a still-pending new request to the onRequestPending hook (push); failures are logged, never thrown. */
function notifyIfPending(ctx: ServiceCtx, dto: AccessRequestDto): AccessRequestDto {
  if (dto.status === 'pending') {
    try {
      ctx.hooks.onRequestPending(ctx, dto.id);
    } catch (err) {
      ctx.logger?.error({ errName: (err as Error).name }, 'pending request hook failed');
    }
  }
  return dto;
}

// ---------- sealing of proposed values ----------

const SEALED_FIELDS = ['ciphertext', 'iv', 'tag', 'wrappedDek', 'dekIv', 'dekTag'] as const;
const requestAad = (requestId: string) => `req:${requestId}`;

function sealProposed(ctx: ServiceCtx, requestId: string, value: string): string {
  const s = seal(ctx.kek, requestAad(requestId), value);
  return JSON.stringify(Object.fromEntries(SEALED_FIELDS.map((f) => [f, s[f].toString('base64')])));
}

function openProposed(ctx: ServiceCtx, requestId: string, stored: string): string {
  const raw = JSON.parse(stored) as Record<string, string>;
  const s = Object.fromEntries(SEALED_FIELDS.map((f) => [f, Buffer.from(raw[f] ?? '', 'base64')])) as Sealed;
  return open(ctx.kek, requestAad(requestId), s);
}

// ---------- shared transitions (call inside a transaction) ----------

const deviceActor = (r: { device_id: string; user_id: string }): Actor => ({ type: 'device', deviceId: r.device_id, userId: r.user_id });

/** Side effects of an approval: read → grant + usage; update → apply the change as the device. */
function applyApproval(ctx: ServiceCtx, r: RequestRow): void {
  // Fresh state inside the transaction (the row may have been loaded before it began).
  const cur = ctx.db.$client.prepare('SELECT allow_plaintext_to_agent AS flag, current_version AS version FROM secrets WHERE id = ?').get(r.secret_id) as
    | { flag: number; version: number }
    | undefined;
  if (!cur) throw new HttpError(404, 'not_found');
  if (r.kind === 'read') {
    if (r.delivery === 'plaintext' && cur.flag !== 1) throw new HttpError(403, 'plaintext_not_allowed');
    const project = touchProject(ctx, r.project);
    recordUsage(ctx, project.id, r.secret_id, r.device_id);
    issueGrant(ctx, { id: r.id, userId: r.user_id, secretId: r.secret_id, deviceId: r.device_id });
    return;
  }
  const pm = r.proposed_meta ? (JSON.parse(r.proposed_meta) as ProposedMeta) : { diff: {}, valueChanged: false };
  // The proposal was made against baseVersion; any change since then makes it stale.
  if (pm.baseVersion !== undefined && pm.baseVersion !== cur.version) throw new HttpError(409, 'stale');
  const meta = Object.fromEntries(Object.entries(pm.diff).map(([k, d]) => [k, d.to])) as Partial<SecretInput>;
  const value = r.proposed_value_sealed ? openProposed(ctx, r.id, r.proposed_value_sealed) : undefined;
  // touchProject + recordUsage + secret.updated audit happen inside applySecretChange (device actor).
  applySecretChange(ctx, deviceActor(r), r.secret_id, { meta, value, project: r.project, reason: r.reason });
  ctx.db.$client.prepare('UPDATE access_requests SET proposed_value_sealed = NULL WHERE id = ?').run(r.id);
}

/** pending → denied by the system; returns false if it was no longer pending. */
function systemDeny(ctx: ServiceCtx, r: RequestRow, cause: SystemCause): boolean {
  const res = ctx.db.$client
    .prepare(
      `UPDATE access_requests SET status = 'denied', decided_by = ?, decided_at = ?, proposed_value_sealed = NULL
        WHERE id = ? AND status = 'pending'`,
    )
    .run(SYSTEM, ctx.clock.now(), r.id);
  if (res.changes === 0) return false;
  appendAudit(ctx.db, ctx.clock, {
    actorType: 'system', actorId: null, event: 'request.denied', secretId: r.secret_id, vaultId: r.vault_id, deviceId: r.device_id,
    project: r.project, meta: { requestId: r.id, kind: r.kind, cause },
  });
  return true;
}

/**
 * Inserts a new request and settles it: (1) the device's standing approval covers it → auto-approved (source 'standing');
 * (2) the owner's auto mode covers the vault → auto-approved (source 'automode'); (3) the standing approval has expired with
 * after_expiry 'renew' → pending renewal request (approving it extends the standing approval); (4) otherwise pending.
 */
function insertAndSettle(
  ctx: ServiceCtx,
  r: {
    id: string; kind: 'read' | 'update'; secretId: string; vaultId: string; device: DeviceIdentity; project: string; reason: string;
    delivery: Delivery | null; proposedMeta: ProposedMeta | null; proposedValueSealed: string | null;
  },
  info: RequestInfo,
): void {
  const { db } = ctx;
  const now = ctx.clock.now();
  db.$client
    .prepare(
      `INSERT INTO access_requests (id, kind, secret_id, device_id, user_id, project, reason, delivery, proposed_meta,
                                    proposed_value_sealed, status, decided_by, auto, created_at, decided_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?)`,
    )
    .run(
      r.id, r.kind, r.secretId, r.device.id, r.device.userId, r.project, r.reason, r.delivery,
      r.proposedMeta === null ? null : JSON.stringify(r.proposedMeta), r.proposedValueSealed, now, now + REQUEST_TTL_MS,
    );
  const auditMeta = {
    requestId: r.id, kind: r.kind,
    ...(r.delivery ? { delivery: r.delivery } : {}),
    ...(r.proposedMeta ? { fields: Object.keys(r.proposedMeta.diff), valueChanged: r.proposedMeta.valueChanged } : {}),
  };
  const common = { secretId: r.secretId, vaultId: r.vaultId, deviceId: r.device.id, project: r.project, reason: r.reason };

  const coverage = standingCoverage(ctx, { deviceId: r.device.id, userId: r.device.userId, secretId: r.secretId, vaultId: r.vaultId, kind: r.kind });
  const source = coverage === 'covered' ? 'standing' : isAutoApproved(ctx, r.device.userId, r.vaultId) ? 'automode' : null;
  if (source === null) {
    const renewal = coverage === 'renewal';
    if (renewal) db.$client.prepare('UPDATE access_requests SET standing_renewal = 1 WHERE id = ?').run(r.id);
    appendAudit(db, ctx.clock, {
      actorType: 'device', actorId: r.device.id, event: 'request.created', ip: info.ip, meta: renewal ? { ...auditMeta, renewal: true } : auditMeta, ...common,
    });
    return;
  }
  try {
    // Savepoint: a failed apply rolls back only the approval, not the inserted request.
    db.$client.transaction(() => {
      db.$client
        .prepare(`UPDATE access_requests SET status = 'approved', auto = 1, auto_source = ?, decided_at = ? WHERE id = ?`)
        .run(source, now, r.id);
      applyOrFail(() => applyApproval(ctx, loadRow(db, r.id)!));
      appendAudit(db, ctx.clock, { actorType: 'system', actorId: null, event: 'request.auto_approved', meta: { ...auditMeta, via: source }, ...common });
    })();
  } catch (err) {
    if (!(err instanceof ApplyFailed)) throw err;
    appendAudit(db, ctx.clock, { actorType: 'device', actorId: r.device.id, event: 'request.created', ip: info.ip, meta: auditMeta, ...common });
    denyApplyFailed(ctx, loadRow(db, r.id)!, SYSTEM, err.errorCode, info);
  }
}

function requireAccessibleActive(ctx: ServiceCtx, userId: string, secretId: string) {
  const secret = loadAccessible(ctx.db, userId, secretId);
  if (secret.archived_at !== null) throw new HttpError(409, 'secret_archived');
  return secret;
}

// ---------- public API ----------

export type CreateRequestInput = { device: DeviceIdentity; secretId: string; project: string; reason: string; delivery: Delivery };

/** Read request by a device. 404 if inaccessible, 409 if archived, 403 plaintext_not_allowed. */
export function createRequest(ctx: ServiceCtx, input: CreateRequestInput, info: RequestInfo = {}): AccessRequestDto {
  const projectName = ProjectNameSchema.parse(input.project);
  const reason = ReasonSchema.parse(input.reason);
  const delivery = DeliverySchema.parse(input.delivery);
  const { device, secretId } = input;
  const id = newId('req');
  ctx.db.$client.transaction(() => {
    const secret = requireAccessibleActive(ctx, device.userId, secretId);
    if (delivery === 'plaintext' && secret.allow_plaintext_to_agent !== 1) throw new HttpError(403, 'plaintext_not_allowed');
    const project = touchProject(ctx, projectName);
    insertAndSettle(
      ctx,
      { id, kind: 'read', secretId, vaultId: secret.vault_id, device, project: project.slug, reason, delivery, proposedMeta: null, proposedValueSealed: null },
      info,
    );
  })();
  emitRequest(ctx, 'request.created', id);
  return notifyIfPending(ctx, getRequestDto(ctx, id));
}

export type CreateUpdateRequestInput = {
  device: DeviceIdentity;
  secretId: string;
  project: string;
  reason: string;
  meta?: Partial<Omit<SecretInput, 'allowPlaintextToAgent'>>;
  value?: string;
  generate?: GenerateSpec;
};

const UpdateMetaSchema = SecretInputSchema.omit({ allowPlaintextToAgent: true }).partial();

/** Update request by a device; the proposed value is sealed immediately (AAD `req:<id>`), generated values server-side. */
export function createUpdateRequest(ctx: ServiceCtx, input: CreateUpdateRequestInput, info: RequestInfo = {}): AccessRequestDto {
  if (input.meta && typeof input.meta === 'object' && 'allowPlaintextToAgent' in input.meta) throw new ValidationError('field_not_allowed');
  const projectName = ProjectNameSchema.parse(input.project);
  const reason = ReasonSchema.parse(input.reason);
  const meta = UpdateMetaSchema.parse(input.meta ?? {});
  const value = input.value === undefined ? undefined : SecretValueSchema.parse(input.value);
  const gen = input.generate === undefined ? undefined : GenerateSchema.parse(input.generate);
  if (value !== undefined && gen !== undefined) throw new ValidationError('value_or_generate');
  const { device, secretId } = input;
  const id = newId('req');

  ctx.db.$client.transaction(() => {
    const secret = requireAccessibleActive(ctx, device.userId, secretId);
    const current: MetaSnapshot = {
      title: secret.title, description: secret.description, tags: JSON.parse(secret.tags) as string[], envName: secret.env_name,
    };
    const diff: RequestMetaDiff = {};
    for (const f of SNAPSHOT_FIELDS) {
      if (meta[f] !== undefined && !same(current[f], meta[f])) diff[f] = { from: current[f], to: meta[f] };
    }
    const newValue = value ?? (gen ? generateValue(gen.length, gen.alphabet) : undefined);
    if (Object.keys(diff).length === 0 && newValue === undefined) throw new ValidationError('no_changes');
    const project = touchProject(ctx, projectName);
    insertAndSettle(
      ctx,
      {
        id, kind: 'update', secretId, vaultId: secret.vault_id, device, project: project.slug, reason, delivery: null,
        proposedMeta: { diff, valueChanged: newValue !== undefined, baseVersion: secret.current_version },
        proposedValueSealed: newValue === undefined ? null : sealProposed(ctx, id, newValue),
      },
      info,
    );
  })();
  emitRequest(ctx, 'request.created', id);
  return notifyIfPending(ctx, getRequestDto(ctx, id));
}

/**
 * Only the device owner decides; re-checks vault access; atomic pending → decided transition.
 * 403 forbidden | 410 expired | 409 already_decided | 409 device_inactive (request is then denied by the system).
 */
export function decideRequest(
  ctx: ServiceCtx,
  input: { requestId: string; userId: string; decision: 'approve' | 'deny' },
  info: RequestInfo = {},
  /** Extra audit meta for the decision entry (e.g. `{ via: 'push' }`); never values. */
  auditMeta: Record<string, string> = {},
): AccessRequestDto {
  const { db } = ctx;
  const decision = DecisionSchema.parse(input.decision);
  const { requestId, userId } = input;
  const row = loadRow(db, requestId);
  if (!row) throw new HttpError(404, 'not_found');
  if (row.user_id !== userId) throw new HttpError(403, 'forbidden');
  if (!canAccessVault(db, userId, row.vault_id)) throw new HttpError(403, 'forbidden');

  // Preconditions whose failure denies the request on behalf of the system.
  const blocked: [SystemCause, HttpError] | null =
    decision !== 'approve'
      ? null
      : row.device_status !== 'approved'
        ? ['device_inactive', new HttpError(409, 'device_inactive')]
        : row.kind === 'read' && row.delivery === 'plaintext' && row.allow_plaintext_to_agent !== 1
          ? ['plaintext_disabled', new HttpError(403, 'plaintext_not_allowed')]
          : null;
  if (blocked) {
    const denied = db.$client.transaction(() => row.expires_at > ctx.clock.now() && systemDeny(ctx, row, blocked[0]))();
    if (denied) {
      emitRequest(ctx, 'request.updated', requestId);
      throw blocked[1];
    }
  }

  let renewed: string | null = null;
  try {
    renewed = decideTxn(ctx, row, decision, userId, info, auditMeta);
  } catch (err) {
    if (!(err instanceof ApplyFailed)) throw err;
    // The change was rolled back; record the failed approval as a denial in a second transaction.
    const denied = db.$client.transaction(() => denyApplyFailed(ctx, row, userId, err.errorCode, info, auditMeta))();
    if (denied) emitRequest(ctx, 'request.updated', requestId);
    throw new HttpError(409, 'apply_failed', undefined, { cause: err.errorCode });
  }
  emitRequest(ctx, 'request.updated', requestId);
  if (renewed) emitDeviceChanged(ctx, row.user_id, renewed);
  return getRequestDto(ctx, requestId);
}

/** Returns the id of the device whose standing approval the approval renewed (the main device for an attached CLI), or null. */
function decideTxn(
  ctx: ServiceCtx, row: RequestRow, decision: 'approve' | 'deny', userId: string, info: RequestInfo, auditMeta: Record<string, string>,
): string | null {
  const { db } = ctx;
  const requestId = row.id;
  return db.$client.transaction((): string | null => {
    const now = ctx.clock.now();
    const status = decision === 'approve' ? 'approved' : 'denied';
    const res = db.$client
      .prepare(
        `UPDATE access_requests
            SET status = ?, decided_by = ?, decided_at = ?,
                proposed_value_sealed = CASE WHEN ? = 'denied' THEN NULL ELSE proposed_value_sealed END
          WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(status, userId, now, status, requestId, now);
    if (res.changes === 0) {
      const cur = db.$client.prepare('SELECT status, expires_at FROM access_requests WHERE id = ?').get(requestId) as
        | { status: RequestStatus; expires_at: number }
        | undefined;
      if (cur && (cur.status === 'expired' || (cur.status === 'pending' && cur.expires_at <= now))) throw new HttpError(410, 'expired');
      throw new HttpError(409, 'already_decided');
    }
    if (decision === 'approve') applyOrFail(() => applyApproval(ctx, row));
    // Denying a renewal request leaves the standing approval expired. Coverage is re-checked at decision time (scope, vault
    // access, kind or after_expiry may have changed since the request was created); if it no longer holds, approve without renewing.
    const renewed =
      decision === 'approve' && renewsNow(ctx, row)
        ? renewOnApproval(ctx, { requestId, deviceId: row.device_id, userId }, info, auditMeta)
        : null;
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: decision === 'approve' ? 'request.approved' : 'request.denied',
      secretId: row.secret_id, vaultId: row.vault_id, deviceId: row.device_id, project: row.project, reason: row.reason, ip: info.ip,
      meta: { ...auditMeta, requestId, kind: row.kind, ...(renewed ? { renewed: 'true' } : {}) },
    });
    return renewed;
  })();
}

/**
 * Long-poll for a decision. Only the requesting device may wait (else 404). Resolves immediately if no longer pending,
 * on the status change event, or after `timeoutMs` (clamped to 0…60 000) with the current state.
 */
const waiters = new Map<string, number>();

const abortError = () => new DOMException('The operation was aborted', 'AbortError');

export async function waitForRequest(
  ctx: ServiceCtx,
  requestId: string,
  deviceId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AccessRequestDto> {
  const row = ctx.db.$client.prepare('SELECT device_id, user_id FROM access_requests WHERE id = ?').get(requestId) as
    | { device_id: string; user_id: string }
    | undefined;
  if (!row || row.device_id !== deviceId) throw new HttpError(404, 'not_found');
  const timeout = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), MAX_WAIT_MS);
  if (signal?.aborted) throw abortError();
  const active = waiters.get(deviceId) ?? 0;
  if (active >= MAX_WAITERS_PER_DEVICE) throw new HttpError(429, 'too_many_waiters');
  waiters.set(deviceId, active + 1);

  return new Promise<AccessRequestDto>((resolve, reject) => {
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
    /** `snapshot`: the event's DTO, used if the request row is gone meanwhile (secret deleted). */
    const finish = (snapshot?: AccessRequestDto) => {
      if (settled) return;
      cleanup();
      try {
        resolve(getRequestDto(ctx, requestId));
      } catch (err) {
        if (snapshot && err instanceof HttpError && err.code === 'not_found') resolve(snapshot);
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
      if ((e.type === 'request.created' || e.type === 'request.updated') && e.data.id === requestId && e.data.status !== 'pending') finish(e.data);
    });
    timer = setTimeout(() => finish(), timeout);
    const cur = ctx.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(requestId) as { status: RequestStatus } | undefined;
    if (!cur || cur.status !== 'pending') finish();
  });
}

/** Marks overdue pending requests expired (audit request.expired), turns off elapsed auto modes and audits elapsed standing approvals. */
export function expireDue(ctx: ServiceCtx): void {
  const { db } = ctx;
  const now = ctx.clock.now();
  const due = db.$client.prepare(`${REQUEST_SELECT} WHERE r.status = 'pending' AND r.expires_at <= ?`).all(now) as RequestRow[];
  const expired: string[] = [];
  db.$client.transaction(() => {
    for (const r of due) {
      const res = db.$client
        .prepare(
          `UPDATE access_requests SET status = 'expired', decided_by = ?, decided_at = ?, proposed_value_sealed = NULL
            WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
        )
        .run(SYSTEM, now, r.id, now);
      if (res.changes === 0) continue;
      appendAudit(db, ctx.clock, {
        actorType: 'system', actorId: null, event: 'request.expired', secretId: r.secret_id, vaultId: r.vault_id, deviceId: r.device_id,
        project: r.project, meta: { requestId: r.id, kind: r.kind },
      });
      expired.push(r.id);
    }
  })();
  // Dead grants carry no capability; keep the table small.
  db.$client.prepare('DELETE FROM grants WHERE expires_at <= ? OR uses_left <= 0').run(now);
  for (const id of expired) emitRequest(ctx, 'request.updated', id);
  expireAutoModes(ctx);
  for (const s of expireStandingApprovals(ctx)) emitDeviceChanged(ctx, s.userId, s.deviceId);
}

/** Archive hook (runs inside the archive transaction): deny open requests (cause 'archived') and delete the secret's grants. */
export function cancelOpenForSecret(ctx: ServiceCtx, secretId: string): void {
  const rows = ctx.db.$client.prepare(`${REQUEST_SELECT} WHERE r.secret_id = ? AND r.status = 'pending'`).all(secretId) as RequestRow[];
  const changed = rows.filter((r) => systemDeny(ctx, r, 'archived')).map((r) => r.id);
  ctx.db.$client.prepare('DELETE FROM grants WHERE secret_id = ?').run(secretId);
  emitAfterCommit(ctx, changed);
}

/** Secret-deletion hook (inside the delete transaction, before the cascade): deny open requests (cause 'deleted'). */
export function cancelOpenForDeletedSecret(ctx: ServiceCtx, secretId: string): void {
  const rows = ctx.db.$client.prepare(`${REQUEST_SELECT} WHERE r.secret_id = ? AND r.status = 'pending'`).all(secretId) as RequestRow[];
  // The rows disappear with the secret, so the events carry a snapshot taken now.
  emitSnapshotsAfterCommit(ctx, rows.filter((r) => systemDeny(ctx, r, 'deleted')).map((r) => r.id));
}

/**
 * Device revocation (inside revokeDevice's transaction): deny the device's open requests (cause 'device_inactive').
 * Also used when a CLI leaves its device group (unlink / relink, cause 'device_link_changed').
 */
export function cancelOpenForDevice(ctx: ServiceCtx, deviceId: string, cause: SystemCause = 'device_inactive'): void {
  const rows = ctx.db.$client.prepare(`${REQUEST_SELECT} WHERE r.device_id = ? AND r.status = 'pending'`).all(deviceId) as RequestRow[];
  emitAfterCommit(ctx, rows.filter((r) => systemDeny(ctx, r, cause)).map((r) => r.id));
}

/**
 * Member-removal hook (runs inside the removal transaction): deny the user's open requests for the vault, delete their grants,
 * and drop the vault's secrets from the user's standing approval lists.
 */
export function revokeForRemovedMember(ctx: ServiceCtx, vaultId: string, userId: string): void {
  const rows = ctx.db.$client
    .prepare(`${REQUEST_SELECT} WHERE r.user_id = ? AND s.vault_id = ? AND r.status = 'pending'`)
    .all(userId, vaultId) as RequestRow[];
  const changed = rows.filter((r) => systemDeny(ctx, r, 'member_removed')).map((r) => r.id);
  ctx.db.$client
    .prepare('DELETE FROM grants WHERE user_id = ? AND secret_id IN (SELECT id FROM secrets WHERE vault_id = ?)')
    .run(userId, vaultId);
  removeForLostVault(ctx, vaultId, userId);
  emitAfterCommit(ctx, changed);
}

/** Plaintext-flag hook (runs inside the change transaction, flag 1 → 0): deny open plaintext requests, delete their grants. */
export function cancelPlaintextForSecret(ctx: ServiceCtx, secretId: string): void {
  const rows = ctx.db.$client
    .prepare(`${REQUEST_SELECT} WHERE r.secret_id = ? AND r.delivery = 'plaintext' AND r.status = 'pending'`)
    .all(secretId) as RequestRow[];
  const changed = rows.filter((r) => systemDeny(ctx, r, 'plaintext_disabled')).map((r) => r.id);
  ctx.db.$client
    .prepare(`DELETE FROM grants WHERE secret_id = ? AND request_id IN (SELECT id FROM access_requests WHERE delivery = 'plaintext')`)
    .run(secretId);
  emitAfterCommit(ctx, changed);
}

/** Real hook implementations, wired by buildApp. */
export const requestHooks: Omit<ServiceHooks, 'onRequestPending' | 'onStandingRequestPending'> = {
  onSecretArchived: cancelOpenForSecret,
  onSecretDeleted: cancelOpenForDeletedSecret,
  onVaultMemberRemoved: revokeForRemovedMember,
  onPlaintextDisabled: cancelPlaintextForSecret,
};
