import type { AutoModeDto } from '@asm/shared';
import { appendAudit } from '../audit/audit.js';
import type { Clock } from '../clock.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import { HttpError, ValidationError } from '../errors.js';
import { canAccessVault } from '../vaults/service.js';

export const DEFAULT_AUTO_MODE_MIN = 30;

type AutoModeRow = { user_id: string; enabled_until: number | null; default_duration_min: number; vault_ids: string | null };

function loadRow(db: Db, userId: string): AutoModeRow | undefined {
  return db.$client.prepare('SELECT * FROM auto_mode WHERE user_id = ?').get(userId) as AutoModeRow | undefined;
}

/** Active ⇔ enabled_until != null && now < enabled_until. */
const isActive = (row: AutoModeRow | undefined, now: number): row is AutoModeRow & { enabled_until: number } =>
  row !== undefined && row.enabled_until !== null && now < row.enabled_until;

function toDto(row: AutoModeRow | undefined, now: number): AutoModeDto {
  const active = isActive(row, now);
  return {
    active,
    enabledUntil: active ? row.enabled_until : null,
    defaultDurationMin: row?.default_duration_min ?? DEFAULT_AUTO_MODE_MIN,
    vaultIds: row?.vault_ids ? (JSON.parse(row.vault_ids) as string[]) : null,
  };
}

export function getAutoMode(ctx: { db: Db; clock: Clock }, userId: string): AutoModeDto {
  return toDto(loadRow(ctx.db, userId), ctx.clock.now());
}

/** Whether a request of `userId` for a secret in `vaultId` is auto-approved right now. */
export function isAutoApproved(ctx: ServiceCtx, userId: string, vaultId: string): boolean {
  const row = loadRow(ctx.db, userId);
  if (!isActive(row, ctx.clock.now())) return false;
  return row.vault_ids === null || (JSON.parse(row.vault_ids) as string[]).includes(vaultId);
}

function emitChanged(ctx: ServiceCtx, userId: string): void {
  ctx.events.emit(userId, { type: 'automode.changed', data: getAutoMode(ctx, userId) });
}

/** `vaultIds` undefined/null = all vaults. Callers (routes) must require recent auth. */
export function enableAutoMode(
  ctx: ServiceCtx,
  userId: string,
  minutes: number,
  vaultIds?: string[] | null,
  info: RequestInfo = {},
): AutoModeDto {
  const { db } = ctx;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > ctx.autoModeMaxMin) throw new ValidationError('invalid_minutes');
  let vaults: string[] | null = null;
  if (vaultIds !== undefined && vaultIds !== null) {
    vaults = [...new Set(vaultIds)];
    if (vaults.length === 0) throw new ValidationError('invalid_vaults');
    for (const v of vaults) if (!canAccessVault(db, userId, v)) throw new HttpError(404, 'vault_not_found');
  }
  const until = ctx.clock.now() + minutes * 60_000;
  db.$client.transaction(() => {
    db.$client
      .prepare(
        `INSERT INTO auto_mode (user_id, enabled_until, default_duration_min, vault_ids) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET enabled_until = excluded.enabled_until,
           default_duration_min = excluded.default_duration_min, vault_ids = excluded.vault_ids`,
      )
      .run(userId, until, minutes, vaults === null ? null : JSON.stringify(vaults));
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: 'automode.enabled', ip: info.ip, meta: { minutes, enabledUntil: until, vaultIds: vaults },
    });
  })();
  emitChanged(ctx, userId);
  return getAutoMode(ctx, userId);
}

export function disableAutoMode(ctx: ServiceCtx, userId: string, info: RequestInfo = {}): AutoModeDto {
  const { db } = ctx;
  const row = loadRow(db, userId);
  if (row && row.enabled_until !== null) {
    const wasActive = isActive(row, ctx.clock.now());
    db.$client.transaction(() => {
      db.$client.prepare('UPDATE auto_mode SET enabled_until = NULL WHERE user_id = ?').run(userId);
      appendAudit(db, ctx.clock, {
        actorType: wasActive ? 'user' : 'system', actorId: userId, event: 'automode.disabled', ip: wasActive ? info.ip : undefined,
        meta: { cause: wasActive ? 'manual' : 'expired' },
      });
    })();
    emitChanged(ctx, userId);
  }
  return getAutoMode(ctx, userId);
}

/** Turns off elapsed auto modes (audit automode.disabled, cause 'expired') and emits automode.changed. */
export function expireAutoModes(ctx: ServiceCtx): void {
  const { db } = ctx;
  const now = ctx.clock.now();
  const due = db.$client
    .prepare('SELECT user_id FROM auto_mode WHERE enabled_until IS NOT NULL AND enabled_until <= ?')
    .all(now) as { user_id: string }[];
  const expired: string[] = [];
  db.$client.transaction(() => {
    for (const { user_id } of due) {
      const res = db.$client
        .prepare('UPDATE auto_mode SET enabled_until = NULL WHERE user_id = ? AND enabled_until IS NOT NULL AND enabled_until <= ?')
        .run(user_id, now);
      if (res.changes === 0) continue;
      // System actor; actor_id names the affected user.
      appendAudit(db, ctx.clock, { actorType: 'system', actorId: user_id, event: 'automode.disabled', meta: { cause: 'expired' } });
      expired.push(user_id);
    }
  })();
  for (const userId of expired) emitChanged(ctx, userId);
}
