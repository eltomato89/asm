import {
  StandingApprovalInputSchema,
  type StandingApprovalDto,
  type StandingApprovalInputRaw,
  type StandingApprovalResponse,
  type StandingApprovalSecret,
  type StandingApprovalSummary,
} from '@asm/shared';
import { appendAudit } from '../audit/audit.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import { settingsDeviceId } from '../devices/links.js';
import { HttpError } from '../errors.js';
import { canAccessVault, deviceDefaultVault } from '../vaults/service.js';

// NOTE: must not import secrets/service.ts or requests/service.ts (both import this module).

export const DAY_MS = 24 * 60 * 60_000;

export type StandingRow = {
  device_id: string; user_id: string; until: number; granted_at: number; scope: 'all' | 'vaults' | 'list';
  include_created: number; allow_updates: number; after_expiry: 'ask' | 'renew'; renew_days: number;
  expiry_audited: number; created_at: number; updated_at: number;
};

/** Effective expiry: the stored `until`, capped at granted_at + maxDays (the admin cap applies retroactively). */
export function effectiveUntil(row: Pick<StandingRow, 'until' | 'granted_at'>, maxDays: number): number {
  return Math.min(row.until, row.granted_at + Math.max(maxDays, 0) * DAY_MS);
}

/** Active ⇔ feature enabled && now < effective expiry (the boundary now == until is not covered). */
export function isActive(row: Pick<StandingRow, 'until' | 'granted_at'>, maxDays: number, now: number): boolean {
  return maxDays > 0 && now < effectiveUntil(row, maxDays);
}

function loadStanding(ctx: ServiceCtx, deviceId: string): StandingRow | undefined {
  return ctx.db.$client.prepare('SELECT * FROM standing_approvals WHERE device_id = ?').get(deviceId) as StandingRow | undefined;
}

function secretCount(ctx: ServiceCtx, deviceId: string): number {
  return (ctx.db.$client.prepare('SELECT count(*) AS n FROM standing_approval_secrets WHERE device_id = ?').get(deviceId) as { n: number }).n;
}

function vaultCount(ctx: ServiceCtx, deviceId: string): number {
  return (ctx.db.$client.prepare('SELECT count(*) AS n FROM standing_approval_vaults WHERE device_id = ?').get(deviceId) as { n: number }).n;
}

/**
 * Short form for DeviceDto (`count` = number of listed secrets, `vaults` = number of covered vaults; looked up if omitted).
 * vaultCount is 0 unless scope 'vaults'.
 */
export function standingSummary(ctx: ServiceCtx, row: StandingRow, count?: number, vaults?: number): StandingApprovalSummary {
  return {
    until: effectiveUntil(row, ctx.standingMaxDays),
    active: isActive(row, ctx.standingMaxDays, ctx.clock.now()),
    scope: row.scope,
    secretCount: count ?? secretCount(ctx, row.device_id),
    vaultCount: row.scope === 'vaults' ? (vaults ?? vaultCount(ctx, row.device_id)) : 0,
    allowUpdates: row.allow_updates === 1,
    afterExpiry: row.after_expiry,
    renewDays: row.renew_days,
  };
}

/** Summaries of all standing approvals of a user, keyed by device id (device list). */
export function standingSummariesForUser(ctx: ServiceCtx, userId: string): Map<string, StandingApprovalSummary> {
  const rows = ctx.db.$client
    .prepare(
      `SELECT sa.*, (SELECT count(*) FROM standing_approval_secrets x WHERE x.device_id = sa.device_id) AS secret_count,
              (SELECT count(*) FROM standing_approval_vaults y WHERE y.device_id = sa.device_id) AS vault_count
         FROM standing_approvals sa WHERE sa.user_id = ?`,
    )
    .all(userId) as (StandingRow & { secret_count: number; vault_count: number })[];
  return new Map(rows.map((r) => [r.device_id, standingSummary(ctx, r, r.secret_count, r.vault_count)]));
}

/** Summary of one device's standing approval, or null (e.g. for MCP whoami). */
export function standingSummaryForDevice(ctx: ServiceCtx, deviceId: string): StandingApprovalSummary | null {
  const row = loadStanding(ctx, deviceId);
  return row ? standingSummary(ctx, row) : null;
}

function toDto(ctx: ServiceCtx, row: StandingRow): StandingApprovalDto {
  const secrets = (
    ctx.db.$client
      .prepare(
        `SELECT s.id, s.title, s.env_name, s.vault_id, v.name AS vault_name, s.archived_at, x.added_by, x.added_at
           FROM standing_approval_secrets x
           JOIN secrets s ON s.id = x.secret_id
           JOIN vaults v ON v.id = s.vault_id
          WHERE x.device_id = ? AND s.vault_id IN (SELECT vault_id FROM vault_members WHERE user_id = ?)
          ORDER BY s.title COLLATE NOCASE, s.id`,
      )
      .all(row.device_id, row.user_id) as {
      id: string; title: string; env_name: string | null; vault_id: string; vault_name: string; archived_at: number | null;
      added_by: 'user' | 'device'; added_at: number;
    }[]
  ).map(
    (s): StandingApprovalSecret => ({
      id: s.id, title: s.title, envName: s.env_name, vaultId: s.vault_id, vaultName: s.vault_name, archived: s.archived_at !== null,
      addedBy: s.added_by, addedAt: s.added_at,
    }),
  );
  const vaults = (
    ctx.db.$client
      .prepare(
        `SELECT v.id, v.name, v.personal_of_user_id IS NOT NULL AS personal
           FROM standing_approval_vaults y
           JOIN vaults v ON v.id = y.vault_id
          WHERE y.device_id = ? AND v.id IN (SELECT vault_id FROM vault_members WHERE user_id = ?)
          ORDER BY v.personal_of_user_id IS NULL, v.name COLLATE NOCASE, v.id`,
      )
      .all(row.device_id, row.user_id) as { id: string; name: string; personal: number }[]
  ).map((v) => ({ id: v.id, name: v.name, personal: v.personal === 1 }));
  return {
    ...standingSummary(ctx, row, secrets.length, vaults.length),
    includeCreated: row.include_created === 1,
    grantedAt: row.granted_at,
    updatedAt: row.updated_at,
    secrets,
    vaults,
  };
}

function requireOwnDevice(ctx: ServiceCtx, userId: string, deviceId: string): { status: string; linked_to_device_id: string | null } {
  const dev = ctx.db.$client
    .prepare('SELECT status, linked_to_device_id FROM devices WHERE id = ? AND user_id = ?')
    .get(deviceId, userId) as { status: string; linked_to_device_id: string | null } | undefined;
  if (!dev) throw new HttpError(404, 'not_found');
  return dev;
}

function response(ctx: ServiceCtx, deviceId: string): StandingApprovalResponse {
  const row = loadStanding(ctx, deviceId);
  return { standingApproval: row ? toDto(ctx, row) : null, maxDays: ctx.standingMaxDays };
}

// ---------- events ----------

export function emitDeviceChanged(ctx: ServiceCtx, userId: string, deviceId: string): void {
  try {
    ctx.events.emit(userId, { type: 'device.changed', data: { deviceId } });
  } catch (err) {
    ctx.logger?.error({ errName: (err as Error).name }, 'device event emission failed');
  }
}

/** For code running inside a caller's transaction: emit once the transaction has finished. */
export function emitDeviceChangedAfterCommit(ctx: ServiceCtx, userId: string, deviceId: string): void {
  queueMicrotask(() => emitDeviceChanged(ctx, userId, deviceId));
}

// ---------- user API (routes) ----------

/**
 * GET: the owner's view of a device's standing approval. 404 not_found unless the device belongs to `userId`.
 * An attached CLI has none of its own (its main device's applies): standingApproval null.
 */
export function getStandingApproval(ctx: ServiceCtx, userId: string, deviceId: string): StandingApprovalResponse {
  const dev = requireOwnDevice(ctx, userId, deviceId);
  if (dev.linked_to_device_id !== null) return { standingApproval: null, maxDays: ctx.standingMaxDays };
  return response(ctx, deviceId);
}

const auditSnapshot = (row: StandingRow, maxDays: number) => ({
  until: effectiveUntil(row, maxDays), scope: row.scope, includeCreated: row.include_created === 1, allowUpdates: row.allow_updates === 1,
  afterExpiry: row.after_expiry, renewDays: row.renew_days,
});

/**
 * PUT (full replace). Callers (routes) must require recent auth.
 * 404 not_found | 409 device_inactive | 409 device_linked (attached CLI: set it on the main device) | 403 standing_disabled | 400 invalid_until | 400 invalid_renew_days | 404 secret_not_found
 * | 404 vault_not_found. Switching scope clears the other scope's rows.
 */
export function setStandingApproval(
  ctx: ServiceCtx, userId: string, deviceId: string, rawInput: StandingApprovalInputRaw, info: RequestInfo = {},
): StandingApprovalResponse {
  const { db } = ctx;
  const input = StandingApprovalInputSchema.parse(rawInput);
  const dev = requireOwnDevice(ctx, userId, deviceId);
  if (dev.status !== 'approved') throw new HttpError(409, 'device_inactive');
  if (dev.linked_to_device_id !== null) throw new HttpError(409, 'device_linked');
  const max = ctx.standingMaxDays;
  if (max <= 0) throw new HttpError(403, 'standing_disabled');
  const now = ctx.clock.now();
  if (!(input.until > now && input.until <= now + max * DAY_MS)) throw new HttpError(400, 'invalid_until');
  if (!(input.renewDays >= 1 && input.renewDays <= max)) throw new HttpError(400, 'invalid_renew_days');
  const ids = input.scope === 'list' ? [...new Set(input.secretIds)] : [];
  const visible = db.$client.prepare(
    'SELECT 1 FROM secrets s JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = ? WHERE s.id = ?',
  );
  for (const id of ids) if (!visible.get(userId, id)) throw new HttpError(404, 'secret_not_found');
  const vaultIds = input.scope === 'vaults' ? [...new Set(input.vaultIds)] : [];
  for (const id of vaultIds) if (!canAccessVault(db, userId, id)) throw new HttpError(404, 'vault_not_found');

  db.$client.transaction(() => {
    const prev = loadStanding(ctx, deviceId);
    db.$client
      .prepare(
        `INSERT INTO standing_approvals (device_id, user_id, until, granted_at, scope, include_created, allow_updates, after_expiry,
                                         renew_days, expiry_audited, created_at, updated_at)
         VALUES (@deviceId, @userId, @until, @now, @scope, @includeCreated, @allowUpdates, @afterExpiry, @renewDays, 0, @now, @now)
         ON CONFLICT (device_id) DO UPDATE SET user_id = excluded.user_id, until = excluded.until, granted_at = excluded.granted_at,
           scope = excluded.scope, include_created = excluded.include_created, allow_updates = excluded.allow_updates,
           after_expiry = excluded.after_expiry, renew_days = excluded.renew_days, expiry_audited = 0, updated_at = excluded.updated_at`,
      )
      .run({
        deviceId, userId, until: input.until, now, scope: input.scope, includeCreated: input.includeCreated ? 1 : 0,
        allowUpdates: input.allowUpdates ? 1 : 0, afterExpiry: input.afterExpiry, renewDays: input.renewDays,
      });
    if (input.scope !== 'list') {
      db.$client.prepare('DELETE FROM standing_approval_secrets WHERE device_id = ?').run(deviceId);
    } else {
      // Keep added_by/added_at of ids that stay on the list.
      db.$client
        .prepare(`DELETE FROM standing_approval_secrets WHERE device_id = ? AND secret_id NOT IN (SELECT value FROM json_each(?))`)
        .run(deviceId, JSON.stringify(ids));
      const ins = db.$client.prepare(
        `INSERT OR IGNORE INTO standing_approval_secrets (device_id, secret_id, added_by, added_at) VALUES (?, ?, 'user', ?)`,
      );
      for (const id of ids) ins.run(deviceId, id, now);
    }
    if (input.scope !== 'vaults') {
      db.$client.prepare('DELETE FROM standing_approval_vaults WHERE device_id = ?').run(deviceId);
    } else {
      // Keep added_at of vaults that stay covered.
      db.$client
        .prepare(`DELETE FROM standing_approval_vaults WHERE device_id = ? AND vault_id NOT IN (SELECT value FROM json_each(?))`)
        .run(deviceId, JSON.stringify(vaultIds));
      const ins = db.$client.prepare('INSERT OR IGNORE INTO standing_approval_vaults (device_id, vault_id, added_at) VALUES (?, ?, ?)');
      for (const id of vaultIds) ins.run(deviceId, id, now);
    }
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: 'standing_approval.set', deviceId, ip: info.ip,
      meta: {
        until: input.until, scope: input.scope, secretCount: ids.length, secretIds: ids, vaultCount: vaultIds.length, vaultIds,
        includeCreated: input.includeCreated,
        allowUpdates: input.allowUpdates, afterExpiry: input.afterExpiry, renewDays: input.renewDays,
        previous: prev ? auditSnapshot(prev, max) : null,
      },
    });
  })();
  emitDeviceChanged(ctx, userId, deviceId);
  return response(ctx, deviceId);
}

/**
 * DELETE (idempotent; no re-auth needed since it reduces rights). 404 not_found unless own device.
 * No-op on an attached CLI (it has no standing approval of its own; the main device's is not touched).
 */
export function removeStandingApproval(ctx: ServiceCtx, userId: string, deviceId: string, info: RequestInfo = {}): StandingApprovalResponse {
  const { db } = ctx;
  const dev = requireOwnDevice(ctx, userId, deviceId);
  if (dev.linked_to_device_id !== null) return { standingApproval: null, maxDays: ctx.standingMaxDays };
  const removed = db.$client.transaction(() => {
    const prev = loadStanding(ctx, deviceId);
    if (!prev) return false;
    db.$client.prepare('DELETE FROM standing_approvals WHERE device_id = ?').run(deviceId);
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: 'standing_approval.removed', deviceId, ip: info.ip,
      meta: { cause: 'manual', previous: auditSnapshot(prev, ctx.standingMaxDays) },
    });
    return true;
  })();
  if (removed) emitDeviceChanged(ctx, userId, deviceId);
  return response(ctx, deviceId);
}

// ---------- hooks (run inside the caller's transaction) ----------

/**
 * Deletes the device's standing approval (inside the caller's transaction): audit `standing_approval.removed` with
 * `meta.cause` (`device_revoked` on revocation, `device_linked` when a CLI is attached to a main device). Actor is the user
 * when `actorUserId` is given, else the system. Returns whether a standing approval existed. Caller emits device.changed.
 */
export function deleteStandingForDevice(
  ctx: ServiceCtx, deviceId: string, cause: 'device_revoked' | 'device_linked', actorUserId?: string,
): boolean {
  const prev = loadStanding(ctx, deviceId);
  if (!prev) return false;
  ctx.db.$client.prepare('DELETE FROM standing_approvals WHERE device_id = ?').run(deviceId);
  appendAudit(ctx.db, ctx.clock, {
    ...(actorUserId ? { actorType: 'user' as const, actorId: actorUserId } : { actorType: 'system' as const, actorId: null }),
    event: 'standing_approval.removed', deviceId,
    meta: { cause, previous: auditSnapshot(prev, ctx.standingMaxDays) },
  });
  return true;
}

/** Device revocation (inside revokeDevice's transaction): delete the standing approval (audit removed, cause device_revoked). */
export function deleteForRevokedDevice(ctx: ServiceCtx, deviceId: string): boolean {
  return deleteStandingForDevice(ctx, deviceId, 'device_revoked');
}

export type StandingCoverage = 'covered' | 'renewal' | null;

/**
 * Whether a new request is approved by the device's standing approval ('covered'), would renew an expired one on approval
 * ('renewal'), or neither. Checks kind (update needs allow_updates), scope (list / covered vaults), vault access, device status
 * and expiry. An attached CLI uses its main device's standing approval; both devices must be approved.
 */
export function standingCoverage(
  ctx: ServiceCtx,
  q: { deviceId: string; userId: string; secretId: string; vaultId: string; kind: 'read' | 'update' },
): StandingCoverage {
  const max = ctx.standingMaxDays;
  if (max <= 0) return null;
  const sid = settingsDeviceId(ctx.db, q.deviceId);
  const row = loadStanding(ctx, sid);
  if (!row || row.user_id !== q.userId) return null;
  if (q.kind === 'update' && row.allow_updates !== 1) return null;
  if (row.scope === 'list') {
    const listed = ctx.db.$client
      .prepare('SELECT 1 FROM standing_approval_secrets WHERE device_id = ? AND secret_id = ?')
      .get(sid, q.secretId);
    if (!listed) return null;
  } else if (row.scope === 'vaults') {
    const covered = ctx.db.$client
      .prepare('SELECT 1 FROM standing_approval_vaults WHERE device_id = ? AND vault_id = ?')
      .get(sid, q.vaultId);
    if (!covered) return null;
  }
  if (!canAccessVault(ctx.db, q.userId, q.vaultId)) return null;
  const approved = ctx.db.$client.prepare("SELECT count(*) AS n FROM devices WHERE id IN (?, ?) AND status = 'approved'").get(q.deviceId, sid) as {
    n: number;
  };
  if (approved.n !== (sid === q.deviceId ? 1 : 2)) return null;
  if (isActive(row, max, ctx.clock.now())) return 'covered';
  return row.after_expiry === 'renew' ? 'renewal' : null;
}

/** Days an approval of a renewal request would extend by, or null if it would not renew (for request DTOs). */
export function renewalDays(
  ctx: ServiceCtx, row: Pick<StandingRow, 'until' | 'granted_at' | 'after_expiry' | 'renew_days'> | null,
): number | null {
  const max = ctx.standingMaxDays;
  if (!row || row.after_expiry !== 'renew' || max <= 0 || isActive(row, max, ctx.clock.now())) return null;
  return Math.min(row.renew_days, max);
}

/**
 * Inside the decision transaction of an approved renewal request: extends an expired standing approval with
 * after_expiry 'renew' to now + min(renew_days, max) days. For an attached CLI's request the main device's standing approval is
 * renewed (audit deviceId = main device, meta.requestDeviceId = the CLI). Idempotent (no-op if already active again).
 * Returns the id of the device whose standing approval was extended (for device.changed), or null.
 */
export function renewOnApproval(
  ctx: ServiceCtx,
  r: { requestId: string; deviceId: string; userId: string },
  info: RequestInfo = {},
  auditMeta: Record<string, string> = {},
): string | null {
  const sid = settingsDeviceId(ctx.db, r.deviceId);
  const row = loadStanding(ctx, sid);
  const days = renewalDays(ctx, row ?? null);
  if (!row || days === null) return null;
  const now = ctx.clock.now();
  const until = now + days * DAY_MS;
  ctx.db.$client
    .prepare('UPDATE standing_approvals SET until = ?, granted_at = ?, expiry_audited = 0, updated_at = ? WHERE device_id = ?')
    .run(until, now, now, sid);
  appendAudit(ctx.db, ctx.clock, {
    actorType: 'user', actorId: r.userId, event: 'standing_approval.renewed', deviceId: sid, ip: info.ip,
    meta: {
      ...auditMeta, requestId: r.requestId, previousUntil: effectiveUntil(row, ctx.standingMaxDays), until, days,
      ...(sid !== r.deviceId ? { requestDeviceId: r.deviceId } : {}),
    },
  });
  return sid;
}

/**
 * Inside createSecret's transaction (device actor): add the new secret to a list-scoped approval with include_created — but only
 * if it was created in the device's effective default vault. (Otherwise a device could create a placeholder in a shared vault,
 * get it auto-listed, and later read a real value another member put in without approval.)
 * A secret created by an attached CLI goes to its main device's list (and must be in the main device's default vault); the audit
 * actor is the creating device, deviceId the main device, meta.createdByDeviceId the CLI.
 */
export function addCreatedSecret(ctx: ServiceCtx, deviceId: string, secretId: string, vaultId: string): boolean {
  const sid = settingsDeviceId(ctx.db, deviceId);
  const row = loadStanding(ctx, sid);
  if (!row || row.scope !== 'list' || row.include_created !== 1) return false;
  if (deviceDefaultVault(ctx.db, sid)?.id !== vaultId) return false;
  const res = ctx.db.$client
    .prepare(`INSERT OR IGNORE INTO standing_approval_secrets (device_id, secret_id, added_by, added_at) VALUES (?, ?, 'device', ?)`)
    .run(sid, secretId, ctx.clock.now());
  if (res.changes === 0) return false;
  appendAudit(ctx.db, ctx.clock, {
    actorType: 'device', actorId: deviceId, event: 'standing_approval.secret_added', deviceId: sid, secretId, vaultId,
    meta: { cause: 'created_by_device', ...(sid !== deviceId ? { createdByDeviceId: deviceId } : {}) },
  });
  emitDeviceChangedAfterCommit(ctx, row.user_id, sid);
  return true;
}

/**
 * Member-removal hook (inside the removal transaction): reset the user's devices whose default vault was this vault, drop the
 * vault's secrets from the user's standing approval lists and the vault from vaults-scoped approvals.
 */
export function removeForLostVault(ctx: ServiceCtx, vaultId: string, userId: string): void {
  const affected = ctx.db.$client
    .prepare(
      `SELECT x.device_id FROM standing_approval_secrets x
         JOIN standing_approvals sa ON sa.device_id = x.device_id
         JOIN secrets s ON s.id = x.secret_id
        WHERE sa.user_id = ? AND s.vault_id = ?
       UNION
       SELECT y.device_id FROM standing_approval_vaults y
         JOIN standing_approvals sa ON sa.device_id = y.device_id
        WHERE sa.user_id = ? AND y.vault_id = ?`,
    )
    .all(userId, vaultId, userId, vaultId) as { device_id: string }[];
  resetDefaultVaultForLostVault(ctx, vaultId, userId);
  if (affected.length === 0) return;
  ctx.db.$client
    .prepare(
      `DELETE FROM standing_approval_secrets
        WHERE device_id IN (SELECT device_id FROM standing_approvals WHERE user_id = ?)
          AND secret_id IN (SELECT id FROM secrets WHERE vault_id = ?)`,
    )
    .run(userId, vaultId);
  ctx.db.$client
    .prepare(
      `DELETE FROM standing_approval_vaults
        WHERE device_id IN (SELECT device_id FROM standing_approvals WHERE user_id = ?) AND vault_id = ?`,
    )
    .run(userId, vaultId);
  for (const a of affected) emitDeviceChangedAfterCommit(ctx, userId, a.device_id);
}

/**
 * Member-removal part: devices of `userId` whose default vault is `vaultId` fall back to the personal vault (default_vault_id
 * NULL), audited as device.default_vault_changed (cause member_removed), device.changed after commit.
 */
function resetDefaultVaultForLostVault(ctx: ServiceCtx, vaultId: string, userId: string): void {
  const devs = ctx.db.$client
    .prepare('SELECT id FROM devices WHERE user_id = ? AND default_vault_id = ?')
    .all(userId, vaultId) as { id: string }[];
  if (devs.length === 0) return;
  ctx.db.$client.prepare('UPDATE devices SET default_vault_id = NULL WHERE user_id = ? AND default_vault_id = ?').run(userId, vaultId);
  for (const d of devs) {
    const fallback = deviceDefaultVault(ctx.db, d.id);
    // System actor; the owner sees it via the device rule. The vault column is the new default, not the lost vault.
    appendAudit(ctx.db, ctx.clock, {
      actorType: 'system', actorId: null, event: 'device.default_vault_changed', deviceId: d.id, vaultId: fallback?.id ?? null,
      meta: { cause: 'member_removed', previousVaultId: vaultId, vaultId: null },
    });
    emitDeviceChangedAfterCommit(ctx, userId, d.id);
  }
}

/**
 * Feature disabled by the admin (max days 0): delete every standing approval (cascade clears lists and vault rows) with audit
 * standing_approval.removed (cause disabled_by_admin), so raising the cap later does not silently reactivate them.
 * Returns the affected devices for device.changed.
 */
export function removeAllStandingApprovals(ctx: ServiceCtx): { userId: string; deviceId: string }[] {
  const { db } = ctx;
  const out: { userId: string; deviceId: string }[] = [];
  db.$client.transaction(() => {
    const rows = db.$client.prepare('SELECT * FROM standing_approvals').all() as StandingRow[];
    const del = db.$client.prepare('DELETE FROM standing_approvals WHERE device_id = ?');
    for (const row of rows) {
      if (del.run(row.device_id).changes === 0) continue;
      appendAudit(db, ctx.clock, {
        actorType: 'system', actorId: null, event: 'standing_approval.removed', deviceId: row.device_id,
        meta: { cause: 'disabled_by_admin', previous: auditSnapshot(row, ctx.standingMaxDays) },
      });
      out.push({ userId: row.user_id, deviceId: row.device_id });
    }
  })();
  return out;
}

/**
 * Sweep: audits each elapsed standing approval once (standing_approval.expired, actor = owner) and returns the affected
 * devices so the caller can emit device.changed. Coverage itself is always checked lazily. While the feature is off
 * (max days 0) it removes all standing approvals instead (removeAllStandingApprovals).
 */
export function expireStandingApprovals(ctx: ServiceCtx): { userId: string; deviceId: string }[] {
  const max = ctx.standingMaxDays;
  if (max <= 0) return removeAllStandingApprovals(ctx);
  const { db } = ctx;
  const now = ctx.clock.now();
  const due = db.$client
    .prepare('SELECT * FROM standing_approvals WHERE expiry_audited = 0 AND min(until, granted_at + ?) <= ?')
    .all(max * DAY_MS, now) as StandingRow[];
  const out: { userId: string; deviceId: string }[] = [];
  db.$client.transaction(() => {
    for (const row of due) {
      const res = db.$client
        .prepare('UPDATE standing_approvals SET expiry_audited = 1 WHERE device_id = ? AND expiry_audited = 0 AND min(until, granted_at + ?) <= ?')
        .run(row.device_id, max * DAY_MS, now);
      if (res.changes === 0) continue;
      // User actor so the owner sees it via the audit actor rule (like automode.disabled/expired).
      appendAudit(db, ctx.clock, {
        actorType: 'user', actorId: row.user_id, event: 'standing_approval.expired', deviceId: row.device_id,
        meta: { until: effectiveUntil(row, max), afterExpiry: row.after_expiry },
      });
      out.push({ userId: row.user_id, deviceId: row.device_id });
    }
  })();
  return out;
}
