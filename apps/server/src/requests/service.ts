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
import { canAccessVault } from '../vaults/service.js';
import { expireAutoModes, isAutoApproved } from './automode.js';
import type { RequestEvent } from './events.js';
import { issueGrant, type Delivery } from './grants.js';

export const REQUEST_TTL_MS = 5 * 60_000;
export const MAX_WAIT_MS = 60_000;
const LIST_LIMIT = 100;
const SYSTEM = 'system';

export type RequestStatus = AccessRequestDto['status'];
export type SystemCause = 'archived' | 'member_removed' | 'device_inactive';

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
function denyApplyFailed(ctx: ServiceCtx, r: RequestRow, decidedBy: string, errorCode: string, info: RequestInfo): boolean {
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
    meta: { requestId: r.id, kind: r.kind, cause: 'apply_failed', error: errorCode },
  });
  return true;
}

/** Stored in access_requests.proposed_meta for update requests (no values). */
type ProposedMeta = { diff: RequestMetaDiff; valueChanged: boolean };

// ---------- rows & DTO ----------

type RequestRow = {
  id: string; kind: 'read' | 'update'; secret_id: string; device_id: string; user_id: string; project: string; reason: string;
  delivery: Delivery | null; proposed_meta: string | null; proposed_value_sealed: string | null; status: RequestStatus;
  decided_by: string | null; auto: number; created_at: number; decided_at: number | null; expires_at: number;
  title: string; env_name: string | null; vault_id: string; vault_name: string;
  device_name: string; device_kind: 'mcp' | 'cli'; device_status: string; decided_by_name: string | null;
};

const REQUEST_SELECT = `
  SELECT r.*, s.title, s.env_name, s.vault_id, v.name AS vault_name,
         d.name AS device_name, d.kind AS device_kind, d.status AS device_status, u.username AS decided_by_name
    FROM access_requests r
    JOIN secrets s ON s.id = r.secret_id
    JOIN vaults v ON v.id = s.vault_id
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN users u ON u.id = r.decided_by`;

function loadRow(db: Db, requestId: string): RequestRow | undefined {
  return db.$client.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(requestId) as RequestRow | undefined;
}

function toDto(r: RequestRow): AccessRequestDto {
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
  };
  if (r.kind === 'update') {
    const pm = r.proposed_meta ? (JSON.parse(r.proposed_meta) as ProposedMeta) : { diff: {}, valueChanged: false };
    dto.metaDiff = pm.diff;
    dto.valueChanged = pm.valueChanged;
  }
  return dto;
}

export function getRequestDto(db: Db, requestId: string): AccessRequestDto {
  const row = loadRow(db, requestId);
  if (!row) throw new HttpError(404, 'not_found');
  return toDto(row);
}

/** The user's own requests (as device owner), newest first, max 100. `pending` hides overdue-but-unswept ones. */
export function listRequests(ctx: ServiceCtx, userId: string, status: 'pending' | 'all' = 'pending'): AccessRequestDto[] {
  const pendingOnly = status === 'pending' ? `AND r.status = 'pending' AND r.expires_at > @now` : '';
  const rows = ctx.db.$client
    .prepare(`${REQUEST_SELECT} WHERE r.user_id = @userId ${pendingOnly} ORDER BY r.created_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`)
    .all({ userId, now: ctx.clock.now() }) as RequestRow[];
  return rows.map(toDto);
}

// ---------- events ----------

function emitRequest(ctx: ServiceCtx, type: 'request.created' | 'request.updated', requestId: string): void {
  const row = loadRow(ctx.db, requestId);
  if (!row) return;
  const event: RequestEvent = { type, data: toDto(row) };
  ctx.events.emit(row.user_id, event);
}

/** For hooks running inside a caller's transaction: emit once the synchronous transaction has finished. */
function emitAfterCommit(ctx: ServiceCtx, requestIds: string[]): void {
  if (requestIds.length === 0) return;
  queueMicrotask(() => {
    for (const id of requestIds) emitRequest(ctx, 'request.updated', id);
  });
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
  if (r.kind === 'read') {
    const project = touchProject(ctx, r.project);
    recordUsage(ctx, project.id, r.secret_id, r.device_id);
    issueGrant(ctx, { id: r.id, userId: r.user_id, secretId: r.secret_id });
    return;
  }
  const pm = r.proposed_meta ? (JSON.parse(r.proposed_meta) as ProposedMeta) : { diff: {}, valueChanged: false };
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

/** Inserts a new request and auto-approves it if the owner's auto mode covers the vault. */
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

  if (!isAutoApproved(ctx, r.device.userId, r.vaultId)) {
    appendAudit(db, ctx.clock, { actorType: 'device', actorId: r.device.id, event: 'request.created', ip: info.ip, meta: auditMeta, ...common });
    return;
  }
  try {
    // Savepoint: a failed apply rolls back only the approval, not the inserted request.
    db.$client.transaction(() => {
      db.$client.prepare(`UPDATE access_requests SET status = 'approved', auto = 1, decided_at = ? WHERE id = ?`).run(now, r.id);
      applyOrFail(() => applyApproval(ctx, loadRow(db, r.id)!));
      appendAudit(db, ctx.clock, { actorType: 'system', actorId: null, event: 'request.auto_approved', meta: auditMeta, ...common });
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
  return getRequestDto(ctx.db, id);
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
        proposedMeta: { diff, valueChanged: newValue !== undefined },
        proposedValueSealed: newValue === undefined ? null : sealProposed(ctx, id, newValue),
      },
      info,
    );
  })();
  emitRequest(ctx, 'request.created', id);
  return getRequestDto(ctx.db, id);
}

/**
 * Only the device owner decides; re-checks vault access; atomic pending → decided transition.
 * 403 forbidden | 410 expired | 409 already_decided | 409 device_inactive (request is then denied by the system).
 */
export function decideRequest(
  ctx: ServiceCtx,
  input: { requestId: string; userId: string; decision: 'approve' | 'deny' },
  info: RequestInfo = {},
): AccessRequestDto {
  const { db } = ctx;
  const decision = DecisionSchema.parse(input.decision);
  const { requestId, userId } = input;
  const row = loadRow(db, requestId);
  if (!row) throw new HttpError(404, 'not_found');
  if (row.user_id !== userId) throw new HttpError(403, 'forbidden');
  if (!canAccessVault(db, userId, row.vault_id)) throw new HttpError(403, 'forbidden');

  if (decision === 'approve' && row.device_status !== 'approved') {
    const denied = db.$client.transaction(() => row.expires_at > ctx.clock.now() && systemDeny(ctx, row, 'device_inactive'))();
    if (denied) {
      emitRequest(ctx, 'request.updated', requestId);
      throw new HttpError(409, 'device_inactive');
    }
  }

  try {
    decideTxn(ctx, row, decision, userId, info);
  } catch (err) {
    if (!(err instanceof ApplyFailed)) throw err;
    // The change was rolled back; record the failed approval as a denial in a second transaction.
    const denied = db.$client.transaction(() => denyApplyFailed(ctx, row, userId, err.errorCode, info))();
    if (denied) emitRequest(ctx, 'request.updated', requestId);
    throw new HttpError(409, 'apply_failed', undefined, { cause: err.errorCode });
  }
  emitRequest(ctx, 'request.updated', requestId);
  return getRequestDto(db, requestId);
}

function decideTxn(ctx: ServiceCtx, row: RequestRow, decision: 'approve' | 'deny', userId: string, info: RequestInfo): void {
  const { db } = ctx;
  const requestId = row.id;
  db.$client.transaction(() => {
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
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: decision === 'approve' ? 'request.approved' : 'request.denied',
      secretId: row.secret_id, vaultId: row.vault_id, deviceId: row.device_id, project: row.project, reason: row.reason, ip: info.ip,
      meta: { requestId, kind: row.kind },
    });
  })();
}

/**
 * Long-poll for a decision. Only the requesting device may wait (else 404). Resolves immediately if no longer pending,
 * on the status change event, or after `timeoutMs` (clamped to 0…60 000) with the current state.
 */
export async function waitForRequest(ctx: ServiceCtx, requestId: string, deviceId: string, timeoutMs: number): Promise<AccessRequestDto> {
  const row = ctx.db.$client.prepare('SELECT device_id, user_id FROM access_requests WHERE id = ?').get(requestId) as
    | { device_id: string; user_id: string }
    | undefined;
  if (!row || row.device_id !== deviceId) throw new HttpError(404, 'not_found');
  const timeout = Math.min(Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 0), MAX_WAIT_MS);

  return new Promise<AccessRequestDto>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      try {
        resolve(getRequestDto(ctx.db, requestId));
      } catch (err) {
        reject(err);
      }
    };
    // Subscribe before checking the status so no transition is missed.
    const unsubscribe = ctx.events.subscribe(row.user_id, (e) => {
      if (e.type !== 'automode.changed' && e.data.id === requestId && e.data.status !== 'pending') finish();
    });
    timer = setTimeout(finish, timeout);
    const cur = ctx.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(requestId) as { status: RequestStatus } | undefined;
    if (!cur || cur.status !== 'pending') finish();
  });
}

/** Marks overdue pending requests expired (audit request.expired) and turns off elapsed auto modes. */
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
  for (const id of expired) emitRequest(ctx, 'request.updated', id);
  expireAutoModes(ctx);
}

/** Archive hook (runs inside the archive transaction): deny open requests (cause 'archived') and delete the secret's grants. */
export function cancelOpenForSecret(ctx: ServiceCtx, secretId: string): void {
  const rows = ctx.db.$client.prepare(`${REQUEST_SELECT} WHERE r.secret_id = ? AND r.status = 'pending'`).all(secretId) as RequestRow[];
  const changed = rows.filter((r) => systemDeny(ctx, r, 'archived')).map((r) => r.id);
  ctx.db.$client.prepare('DELETE FROM grants WHERE secret_id = ?').run(secretId);
  emitAfterCommit(ctx, changed);
}

/** Member-removal hook (runs inside the removal transaction): deny the user's open requests for the vault, delete their grants. */
export function revokeForRemovedMember(ctx: ServiceCtx, vaultId: string, userId: string): void {
  const rows = ctx.db.$client
    .prepare(`${REQUEST_SELECT} WHERE r.user_id = ? AND s.vault_id = ? AND r.status = 'pending'`)
    .all(userId, vaultId) as RequestRow[];
  const changed = rows.filter((r) => systemDeny(ctx, r, 'member_removed')).map((r) => r.id);
  ctx.db.$client
    .prepare('DELETE FROM grants WHERE user_id = ? AND secret_id IN (SELECT id FROM secrets WHERE vault_id = ?)')
    .run(userId, vaultId);
  emitAfterCommit(ctx, changed);
}

/** Real hook implementations, wired by buildApp. */
export const requestHooks: ServiceHooks = {
  onSecretArchived: cancelOpenForSecret,
  onVaultMemberRemoved: revokeForRemovedMember,
};
