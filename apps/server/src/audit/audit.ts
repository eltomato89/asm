import { createHash } from 'node:crypto';
import { newId } from '@asm/shared';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';

export type AuditEvent =
  | 'auth.login' | 'auth.login_failed'
  | 'device.pair_requested' | 'device.approved' | 'device.denied' | 'device.revoked' | 'device.default_vault_changed'
  | 'device.linked' | 'device.unlinked'
  | 'secret.searched'
  | 'request.created' | 'request.approved' | 'request.denied' | 'request.auto_approved' | 'request.expired'
  | 'grant.redeemed' | 'grant.redeem_denied'
  | 'secret.plaintext_delivered' | 'secret.created' | 'secret.updated' | 'secret.deleted'
  | 'secret.revealed' | 'secret.version_revealed' | 'secret.version_restored'
  | 'secret.archived' | 'secret.unarchived'
  | 'automode.enabled' | 'automode.disabled'
  | 'standing_approval.set' | 'standing_approval.removed' | 'standing_approval.renewed' | 'standing_approval.expired'
  | 'standing_approval.secret_added'
  | 'vault.member_added' | 'vault.member_removed';

export type AuditActorType = 'user' | 'device' | 'system';

export interface AuditRow {
  seq: number;
  id: string;
  ts: number;
  actorType: AuditActorType;
  actorId: string | null;
  event: string;
  secretId: string | null;
  vaultId: string | null;
  deviceId: string | null;
  project: string | null;
  reason: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}

export interface AuditEntry {
  actorType: AuditActorType;
  actorId: string | null;
  event: AuditEvent;
  secretId?: string | null;
  vaultId?: string | null;
  deviceId?: string | null;
  project?: string | null;
  reason?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown> | null;
}

export class AuditCursorError extends Error {
  constructor() {
    super('invalid audit cursor');
    this.name = 'AuditCursorError';
  }
}

export class AuditMetaError extends Error {
  constructor(key: string) {
    super(`audit meta must not contain key "${key}"`);
    this.name = 'AuditMetaError';
  }
}

const GENESIS_HASH = '0'.repeat(64);
const FORBIDDEN_KEYS = new Set(['value', 'plaintext', 'secret']);

interface RawRow {
  seq: number; id: string; ts: number; actor_type: AuditActorType; actor_id: string | null;
  event: string; secret_id: string | null; vault_id: string | null; device_id: string | null;
  project: string | null; reason: string | null; ip: string | null; meta: string | null;
  prev_hash: string; hash: string;
}

function assertSafeMeta(v: unknown): void {
  if (Array.isArray(v)) {
    v.forEach(assertSafeMeta);
  } else if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) throw new AuditMetaError(k);
      assertSafeMeta(child);
    }
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function computeHash(r: RawRow, meta: unknown): string {
  const fields = {
    id: r.id, ts: r.ts, actor_type: r.actor_type, actor_id: r.actor_id, event: r.event,
    secret_id: r.secret_id, vault_id: r.vault_id, device_id: r.device_id, project: r.project,
    reason: r.reason, ip: r.ip, meta, prev_hash: r.prev_hash,
  };
  return createHash('sha256').update(r.prev_hash + canonical(fields)).digest('hex');
}

function toRow(r: RawRow): AuditRow {
  return {
    seq: r.seq, id: r.id, ts: r.ts, actorType: r.actor_type, actorId: r.actor_id, event: r.event,
    secretId: r.secret_id, vaultId: r.vault_id, deviceId: r.device_id, project: r.project,
    reason: r.reason, ip: r.ip, meta: r.meta === null ? null : (JSON.parse(r.meta) as Record<string, unknown>),
    prevHash: r.prev_hash, hash: r.hash,
  };
}

export function appendAudit(db: Db, clock: Clock, entry: AuditEntry): AuditRow {
  // Normalize first so the hashed value is exactly what is stored and re-parsed.
  const meta: Record<string, unknown> | null =
    entry.meta == null ? null : (JSON.parse(JSON.stringify(entry.meta)) as Record<string, unknown>);
  assertSafeMeta(meta);
  const raw = db.$client;
  // Nests as a savepoint when called inside an outer better-sqlite3 transaction.
  return raw.transaction((): AuditRow => {
    const last = raw.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    const row: RawRow = {
      seq: 0,
      id: newId('aud'),
      ts: clock.now(),
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      event: entry.event,
      secret_id: entry.secretId ?? null,
      vault_id: entry.vaultId ?? null,
      device_id: entry.deviceId ?? null,
      project: entry.project ?? null,
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      meta: meta === null ? null : JSON.stringify(meta),
      prev_hash: last?.hash ?? GENESIS_HASH,
      hash: '',
    };
    row.hash = computeHash(row, meta);
    const info = raw.prepare(
      `INSERT INTO audit_log (id, ts, actor_type, actor_id, event, secret_id, vault_id, device_id, project, reason, ip, meta, prev_hash, hash)
       VALUES (@id, @ts, @actor_type, @actor_id, @event, @secret_id, @vault_id, @device_id, @project, @reason, @ip, @meta, @prev_hash, @hash)`,
    ).run(row);
    return toRow({ ...row, seq: Number(info.lastInsertRowid) });
  })();
}

export function verifyChain(db: Db): { ok: true } | { ok: false; brokenAtSeq: number } {
  let prev = GENESIS_HASH;
  for (const r of db.$client.prepare('SELECT * FROM audit_log ORDER BY seq ASC').iterate() as Iterable<RawRow>) {
    let meta: unknown = null;
    try {
      meta = r.meta === null ? null : JSON.parse(r.meta);
    } catch {
      return { ok: false, brokenAtSeq: r.seq };
    }
    if (r.prev_hash !== prev || computeHash(r, meta) !== r.hash) return { ok: false, brokenAtSeq: r.seq };
    prev = r.hash;
  }
  return { ok: true };
}

export interface AuditFilter {
  userId: string;
  /** Admins additionally see system-actor rows not tied to a vault/secret (e.g. auth.login_failed). */
  includeSystem?: boolean;
  deviceId?: string;
  secretId?: string;
  project?: string;
  event?: string;
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
}

/**
 * Slugs that resolve to the same canonical project as the slug @project (follows projects.merged_into up to the root,
 * then collects every project merged into it, transitively). Audit rows keep the slug they were written with.
 */
const PROJECT_FAMILY_SLUGS = `
  WITH RECURSIVE
    up(id, merged_into, depth) AS (
      SELECT id, merged_into, 0 FROM projects WHERE slug = @project
      UNION ALL SELECT p.id, p.merged_into, up.depth + 1 FROM projects p JOIN up ON p.id = up.merged_into WHERE up.depth < 100
    ),
    root(id) AS (SELECT id FROM up WHERE merged_into IS NULL),
    down(id, slug, depth) AS (
      SELECT p.id, p.slug, 0 FROM projects p JOIN root ON p.id = root.id
      UNION ALL SELECT p.id, p.slug, down.depth + 1 FROM projects p JOIN down ON p.merged_into = down.id WHERE down.depth < 100
    )
  SELECT slug FROM down
  UNION SELECT @project`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function queryAudit(db: Db, filter: AuditFilter): { items: AuditRow[]; nextCursor?: string } {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where: string[] = [
    `(vault_id IN (SELECT vault_id FROM vault_members WHERE user_id = @userId)
      OR (actor_type = 'user' AND actor_id = @userId)
      OR device_id IN (SELECT id FROM devices WHERE user_id = @userId)${filter.includeSystem ? " OR (actor_type = 'system' AND vault_id IS NULL AND secret_id IS NULL)" : ''})`,
  ];
  const params: Record<string, string | number> = { userId: filter.userId, limit: limit + 1 };
  const add = (cond: string, key: string, val: string | number | undefined) => {
    if (val === undefined) return;
    where.push(cond);
    params[key] = val;
  };
  add('device_id = @deviceId', 'deviceId', filter.deviceId);
  add('secret_id = @secretId', 'secretId', filter.secretId);
  add(`project IN (${PROJECT_FAMILY_SLUGS})`, 'project', filter.project);
  add('event = @event', 'event', filter.event);
  add('ts >= @from', 'from', filter.from);
  add('ts <= @to', 'to', filter.to);
  if (filter.cursor !== undefined) {
    const c = Number(filter.cursor);
    if (!/^\d+$/.test(filter.cursor) || !Number.isSafeInteger(c)) throw new AuditCursorError();
    add('seq < @cursor', 'cursor', c);
  }
  const rows = db.$client
    .prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT @limit`)
    .all(params) as RawRow[];
  const page = rows.slice(0, limit).map(toRow);
  const last = page[page.length - 1];
  return rows.length > limit && last ? { items: page, nextCursor: String(last.seq) } : { items: page };
}
