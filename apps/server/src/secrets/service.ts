import { randomInt } from 'node:crypto';
import {
  ArchiveInputSchema,
  GenerateSchema,
  newId,
  ProjectNameSchema,
  ReasonSchema,
  SecretCreateSchema,
  SecretInputSchema,
  SecretValueSchema,
  type ActorRef,
  type SecretHistory,
  type SecretInput,
  type SecretMeta,
  type SecretVersionDto,
} from '@asm/shared';
import { eq } from 'drizzle-orm';
import { appendAudit } from '../audit/audit.js';
import { auditActor, type Actor, type RequestInfo, type ServiceCtx } from '../context.js';
import { open, seal, type Sealed } from '../crypto/envelope.js';
import type { Db } from '../db/client.js';
import { secrets, secretVersions, type MetaSnapshot } from '../db/schema.js';
import { HttpError, ValidationError } from '../errors.js';
import { recordUsage, touchProject, type Project } from '../projects/service.js';
import { canAccessVault, personalVaultId } from '../vaults/service.js';

// ---------- types ----------

export type GenerateSpec = { length: number; alphabet?: 'alnum' | 'hex' | 'base64url' | 'symbols' };

export type CreateSecretInput = SecretInput & {
  vaultId?: string;
  value?: string;
  generate?: GenerateSpec;
  project?: string;
  reason?: string;
};

export type SecretChange = {
  meta?: Partial<SecretInput>;
  value?: string;
  generate?: GenerateSpec;
  project?: string;
  reason?: string;
  restoredFrom?: number;
};

export type SearchOptions = { vaultId?: string; includeArchived?: boolean; status?: 'active' | 'archived' | 'all' };

// ---------- value generation ----------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALPHABETS: Record<NonNullable<GenerateSpec['alphabet']>, string> = {
  alnum: ALNUM,
  hex: '0123456789abcdef',
  base64url: `${ALNUM}-_`,
  symbols: `${ALNUM}!#$%&*+-=?@^_`,
};

/** Uniformly random string (crypto.randomInt, no modulo bias). */
export function generateValue(length: number, alphabet: GenerateSpec['alphabet'] = 'alnum'): string {
  if (!Number.isInteger(length) || length < 16 || length > 256) throw new ValidationError('invalid_length');
  const chars = ALPHABETS[alphabet];
  if (!chars) throw new ValidationError('invalid_alphabet');
  let out = '';
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

// ---------- reads ----------

type SecretRow = {
  id: string; vault_id: string; vault_name: string; title: string; description: string; tags: string; env_name: string | null;
  allow_plaintext_to_agent: number; current_version: number; updated_at: number;
  archived_at: number | null; archived_by_type: 'user' | 'device' | null; archived_by_id: string | null; archived_by_name: string | null;
  archive_reason: string | null; archive_project: string | null;
};

// Joins the caller's membership, so every query through it only sees accessible vaults.
const META_SELECT = `
  SELECT s.id, s.vault_id, v.name AS vault_name, s.title, s.description, s.tags, s.env_name, s.allow_plaintext_to_agent,
         s.current_version, s.updated_at, s.archived_at, s.archived_by_type, s.archived_by_id,
         CASE s.archived_by_type WHEN 'user' THEN ua.username WHEN 'device' THEN da.name END AS archived_by_name,
         s.archive_reason, s.archive_project
    FROM secrets s
    JOIN vaults v ON v.id = s.vault_id
    JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = @userId
    LEFT JOIN users ua ON s.archived_by_type = 'user' AND ua.id = s.archived_by_id
    LEFT JOIN devices da ON s.archived_by_type = 'device' AND da.id = s.archived_by_id`;

function toMeta(r: SecretRow): SecretMeta {
  return {
    id: r.id,
    vaultId: r.vault_id,
    vaultName: r.vault_name,
    title: r.title,
    description: r.description,
    tags: JSON.parse(r.tags) as string[],
    envName: r.env_name,
    allowPlaintextToAgent: r.allow_plaintext_to_agent === 1,
    updatedAt: r.updated_at,
    archived:
      r.archived_at === null
        ? null
        : {
            at: r.archived_at,
            by: { type: r.archived_by_type ?? 'user', id: r.archived_by_id ?? '', name: r.archived_by_name ?? r.archived_by_id ?? '' },
            reason: r.archive_reason ?? '',
            project: r.archive_project,
          },
  };
}

function snapshotOf(r: SecretRow): MetaSnapshot {
  return { title: r.title, description: r.description, tags: JSON.parse(r.tags) as string[], envName: r.env_name };
}

/** The secret if the user is a member of its vault, else 404 (no existence oracle). */
function loadAccessible(db: Db, userId: string, secretId: string): SecretRow {
  const row = db.$client.prepare(`${META_SELECT} WHERE s.id = @secretId`).get({ userId, secretId }) as SecretRow | undefined;
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

export function getSecretMeta(db: Db, userId: string, secretId: string): SecretMeta {
  return toMeta(loadAccessible(db, userId, secretId));
}

/** Metas for the given ids that the user may access (inaccessible ids are dropped). */
export function secretMetasByIds(db: Db, userId: string, ids: string[]): SecretMeta[] {
  if (ids.length === 0) return [];
  const rows = db.$client
    .prepare(`${META_SELECT} WHERE s.id IN (SELECT value FROM json_each(@ids))`)
    .all({ userId, ids: JSON.stringify(ids) }) as SecretRow[];
  return rows.map(toMeta);
}

const SEARCH_LIMIT = 50;

/** Each whitespace-separated term becomes a quoted FTS5 prefix phrase; terms are AND-joined. */
function ftsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.length ? terms.join(' AND ') : null;
}

export function searchSecrets(db: Db, userId: string, query: string, opts: SearchOptions = {}): SecretMeta[] {
  const status = opts.status ?? (opts.includeArchived ? 'all' : 'active');
  const where: string[] = [];
  const params: Record<string, string | number> = { userId, limit: SEARCH_LIMIT };
  if (status === 'active') where.push('s.archived_at IS NULL');
  if (status === 'archived') where.push('s.archived_at IS NOT NULL');
  if (opts.vaultId !== undefined) {
    where.push('s.vault_id = @vaultId');
    params.vaultId = opts.vaultId;
  }
  const match = ftsQuery(query);
  if (match) {
    where.push('s.id IN (SELECT secret_id FROM secrets_fts WHERE secrets_fts MATCH @match)');
    params.match = match;
  }
  const sql = `${META_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.updated_at DESC, s.id DESC LIMIT @limit`;
  return (db.$client.prepare(sql).all(params) as SecretRow[]).map(toMeta);
}

// ---------- writes ----------

function userOnly(actor: Actor): void {
  if (actor.type !== 'user') throw new HttpError(403, 'forbidden_for_device');
}

function requireDeviceContext(actor: Actor, input: { project?: string; reason?: string }, opts: { reason: boolean }): void {
  if (actor.type !== 'device') return;
  if (input.project === undefined) throw new ValidationError('project_required');
  if (opts.reason && input.reason === undefined) throw new ValidationError('reason_required');
}

function loadVersion(db: Db, secretId: string, version: number): { sealed: Sealed; snapshot: MetaSnapshot } {
  const row = db.$client
    .prepare(
      `SELECT ciphertext, iv, tag, wrapped_dek AS wrappedDek, dek_iv AS dekIv, dek_tag AS dekTag, meta_snapshot AS metaSnapshot
         FROM secret_versions WHERE secret_id = ? AND version = ?`,
    )
    .get(secretId, version) as (Sealed & { metaSnapshot: string }) | undefined;
  if (!row) throw new HttpError(404, 'version_not_found');
  const { metaSnapshot, ...sealed } = row;
  return { sealed, snapshot: JSON.parse(metaSnapshot) as MetaSnapshot };
}

function openVersion(ctx: ServiceCtx, secretId: string, version: number): { plaintext: string; snapshot: MetaSnapshot } {
  const { sealed, snapshot } = loadVersion(ctx.db, secretId, version);
  return { plaintext: open(ctx.kek, `${secretId}:${version}`, sealed), snapshot };
}

function insertVersion(
  ctx: ServiceCtx,
  actor: Actor,
  v: { secretId: string; version: number; plaintext: string; snapshot: MetaSnapshot; project: string | null; reason: string | null; restoredFrom: number | null },
): void {
  const sealed = seal(ctx.kek, `${v.secretId}:${v.version}`, v.plaintext);
  ctx.db
    .insert(secretVersions)
    .values({
      secretId: v.secretId,
      version: v.version,
      ...sealed,
      metaSnapshot: v.snapshot,
      changedByType: actor.type,
      changedById: actor.type === 'user' ? actor.userId : actor.deviceId,
      project: v.project,
      reason: v.reason,
      restoredFrom: v.restoredFrom,
      createdAt: ctx.clock.now(),
    })
    .run();
}

function useProject(ctx: ServiceCtx, name: string | undefined): Project | undefined {
  return name === undefined ? undefined : touchProject(ctx, name);
}

function noteUsage(ctx: ServiceCtx, actor: Actor, project: Project | undefined, secretId: string): void {
  if (project && actor.type === 'device') recordUsage(ctx, project.id, secretId, actor.deviceId);
}

export function createSecret(ctx: ServiceCtx, actor: Actor, input: CreateSecretInput, info: RequestInfo = {}): SecretMeta {
  const { db } = ctx;
  if (actor.type === 'device' && 'allowPlaintextToAgent' in input) throw new ValidationError('field_not_allowed');
  requireDeviceContext(actor, input, { reason: true });
  const data = SecretCreateSchema.parse(input);
  if ((data.value === undefined) === (data.generate === undefined)) throw new ValidationError('value_or_generate');
  const vaultId = data.vaultId ?? personalVaultId(db, actor.userId);
  if (!canAccessVault(db, actor.userId, vaultId)) throw new HttpError(404, 'vault_not_found');
  const plaintext = data.value ?? generateValue(data.generate!.length, data.generate!.alphabet);
  const snapshot: MetaSnapshot = { title: data.title, description: data.description ?? '', tags: data.tags ?? [], envName: data.envName ?? null };
  const id = newId('sec');
  const now = ctx.clock.now();

  db.$client.transaction(() => {
    const project = useProject(ctx, data.project);
    db.insert(secrets)
      .values({
        id,
        vaultId,
        ...snapshot,
        allowPlaintextToAgent: data.allowPlaintextToAgent ?? false,
        currentVersion: 1,
        createdByType: actor.type,
        createdById: actor.type === 'user' ? actor.userId : actor.deviceId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertVersion(ctx, actor, { secretId: id, version: 1, plaintext, snapshot, project: project?.slug ?? null, reason: data.reason ?? null, restoredFrom: null });
    noteUsage(ctx, actor, project, id);
    appendAudit(db, ctx.clock, {
      ...auditActor(actor), event: 'secret.created', secretId: id, vaultId, project: project?.slug, reason: data.reason, ip: info.ip, meta: { version: 1 },
    });
  })();
  return getSecretMeta(db, actor.userId, id);
}

const SNAPSHOT_FIELDS = ['title', 'description', 'tags', 'envName'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Writes version current+1 (unchanged value is re-sealed for the new version) and updates metadata/FTS. */
export function applySecretChange(ctx: ServiceCtx, actor: Actor, secretId: string, change: SecretChange, info: RequestInfo = {}): SecretMeta {
  const { db } = ctx;
  if (actor.type === 'device' && change.meta && 'allowPlaintextToAgent' in change.meta) throw new ValidationError('field_not_allowed');
  requireDeviceContext(actor, change, { reason: true });
  const row = loadAccessible(db, actor.userId, secretId);
  if (row.archived_at !== null) throw new HttpError(409, 'secret_archived');

  const meta = SecretInputSchema.partial().parse(change.meta ?? {});
  const newValue = change.value === undefined ? undefined : SecretValueSchema.parse(change.value);
  const gen = change.generate === undefined ? undefined : GenerateSchema.parse(change.generate);
  if (newValue !== undefined && gen !== undefined) throw new ValidationError('value_or_generate');
  const projectName = change.project === undefined ? undefined : ProjectNameSchema.parse(change.project);
  const reason = change.reason === undefined ? undefined : ReasonSchema.parse(change.reason);

  const prev = snapshotOf(row);
  const next: MetaSnapshot = {
    title: meta.title ?? prev.title,
    description: meta.description ?? prev.description,
    tags: meta.tags ?? prev.tags,
    envName: meta.envName !== undefined ? meta.envName : prev.envName,
  };
  const allowPlaintextToAgent = meta.allowPlaintextToAgent ?? row.allow_plaintext_to_agent === 1;
  const changed: string[] = SNAPSHOT_FIELDS.filter((f) => !same(prev[f], next[f]));
  if (allowPlaintextToAgent !== (row.allow_plaintext_to_agent === 1)) changed.push('allowPlaintextToAgent');
  if (newValue !== undefined || gen !== undefined) changed.push('value');
  if (changed.length === 0 && change.restoredFrom === undefined) throw new ValidationError('no_changes');

  const version = row.current_version + 1;
  db.$client.transaction(() => {
    const plaintext = newValue ?? (gen ? generateValue(gen.length, gen.alphabet) : openVersion(ctx, secretId, row.current_version).plaintext);
    const project = useProject(ctx, projectName);
    insertVersion(ctx, actor, {
      secretId, version, plaintext, snapshot: next, project: project?.slug ?? null, reason: reason ?? null, restoredFrom: change.restoredFrom ?? null,
    });
    db.update(secrets)
      .set({ ...next, allowPlaintextToAgent, currentVersion: version, updatedAt: ctx.clock.now() })
      .where(eq(secrets.id, secretId))
      .run();
    noteUsage(ctx, actor, project, secretId);
    const restored = change.restoredFrom !== undefined;
    appendAudit(db, ctx.clock, {
      ...auditActor(actor),
      event: restored ? 'secret.version_restored' : 'secret.updated',
      secretId,
      vaultId: row.vault_id,
      project: project?.slug,
      reason,
      ip: info.ip,
      meta: { version, changed, ...(restored ? { restoredFrom: change.restoredFrom } : {}) },
    });
  })();
  return getSecretMeta(db, actor.userId, secretId);
}

export function restoreVersion(ctx: ServiceCtx, actor: Actor, secretId: string, version: number, info: RequestInfo = {}): SecretMeta {
  userOnly(actor);
  const row = loadAccessible(ctx.db, actor.userId, secretId);
  if (row.archived_at !== null) throw new HttpError(409, 'secret_archived');
  const old = openVersion(ctx, secretId, version);
  return applySecretChange(ctx, actor, secretId, { value: old.plaintext, meta: old.snapshot, restoredFrom: version }, info);
}

export function deleteSecret(ctx: ServiceCtx, actor: Actor, secretId: string, info: RequestInfo = {}): void {
  userOnly(actor);
  const { db } = ctx;
  const row = loadAccessible(db, actor.userId, secretId);
  db.$client.transaction(() => {
    appendAudit(db, ctx.clock, {
      ...auditActor(actor), event: 'secret.deleted', secretId, vaultId: row.vault_id, ip: info.ip, meta: { title: row.title },
    });
    db.delete(secrets).where(eq(secrets.id, secretId)).run();
  })();
}

/** Human-only plaintext reveal of the current or a given version; audited. */
export function revealSecret(ctx: ServiceCtx, actor: Actor, secretId: string, version?: number, info: RequestInfo = {}): string {
  userOnly(actor);
  const row = loadAccessible(ctx.db, actor.userId, secretId);
  if (row.archived_at !== null) throw new HttpError(409, 'secret_archived');
  const v = version ?? row.current_version;
  const { plaintext } = openVersion(ctx, secretId, v);
  appendAudit(ctx.db, ctx.clock, {
    ...auditActor(actor),
    event: version === undefined ? 'secret.revealed' : 'secret.version_revealed',
    secretId,
    vaultId: row.vault_id,
    ip: info.ip,
    meta: { version: v },
  });
  return plaintext;
}

export function archiveSecret(
  ctx: ServiceCtx,
  actor: Actor,
  secretId: string,
  input: { reason: string; project?: string },
  info: RequestInfo = {},
): SecretMeta {
  const { db } = ctx;
  requireDeviceContext(actor, input, { reason: false });
  const data = ArchiveInputSchema.parse(input);
  const row = loadAccessible(db, actor.userId, secretId);
  if (row.archived_at !== null) throw new HttpError(409, 'already_archived');
  db.$client.transaction(() => {
    const project = useProject(ctx, data.project);
    const now = ctx.clock.now();
    db.update(secrets)
      .set({
        archivedAt: now,
        archivedByType: actor.type,
        archivedById: actor.type === 'user' ? actor.userId : actor.deviceId,
        archiveReason: data.reason,
        archiveProject: project?.slug ?? null,
        updatedAt: now,
      })
      .where(eq(secrets.id, secretId))
      .run();
    noteUsage(ctx, actor, project, secretId);
    appendAudit(db, ctx.clock, {
      ...auditActor(actor), event: 'secret.archived', secretId, vaultId: row.vault_id, project: project?.slug, reason: data.reason, ip: info.ip,
    });
    ctx.hooks.onSecretArchived(ctx, secretId);
  })();
  return getSecretMeta(db, actor.userId, secretId);
}

export function unarchiveSecret(ctx: ServiceCtx, actor: Actor, secretId: string, info: RequestInfo = {}): SecretMeta {
  userOnly(actor);
  const { db } = ctx;
  const row = loadAccessible(db, actor.userId, secretId);
  if (row.archived_at === null) throw new HttpError(409, 'not_archived');
  db.$client.transaction(() => {
    db.update(secrets)
      .set({ archivedAt: null, archivedByType: null, archivedById: null, archiveReason: null, archiveProject: null, updatedAt: ctx.clock.now() })
      .where(eq(secrets.id, secretId))
      .run();
    appendAudit(db, ctx.clock, { ...auditActor(actor), event: 'secret.unarchived', secretId, vaultId: row.vault_id, ip: info.ip });
  })();
  return getSecretMeta(db, actor.userId, secretId);
}

// ---------- history ----------

const NAME_OF = (alias: string, typeCol: string, idCol: string) => `
  CASE ${typeCol} WHEN 'user' THEN (SELECT username FROM users WHERE id = ${idCol})
                  WHEN 'device' THEN (SELECT name FROM devices WHERE id = ${idCol}) END AS ${alias}`;

function actorRef(type: string, id: string | null, name: string | null): ActorRef | null {
  if (type !== 'user' && type !== 'device') return null;
  return { type, id: id ?? '', name: name ?? id ?? '' };
}

function metaDiff(prev: MetaSnapshot | null, next: MetaSnapshot): SecretVersionDto['metaDiff'] {
  const diff: SecretVersionDto['metaDiff'] = {};
  for (const f of SNAPSHOT_FIELDS) {
    if (!prev || !same(prev[f], next[f])) diff[f] = { from: prev ? prev[f] : null, to: next[f] };
  }
  return diff;
}

/** Versions (newest first, never values) plus archive/unarchive events from the audit log. */
export function listHistory(db: Db, userId: string, secretId: string): SecretHistory {
  loadAccessible(db, userId, secretId);
  const rows = db.$client
    .prepare(
      `SELECT version, meta_snapshot, changed_by_type, changed_by_id, project, reason, restored_from, created_at,
              ${NAME_OF('changed_by_name', 'changed_by_type', 'changed_by_id')}
         FROM secret_versions WHERE secret_id = ? ORDER BY version ASC`,
    )
    .all(secretId) as {
    version: number; meta_snapshot: string; changed_by_type: string; changed_by_id: string; changed_by_name: string | null;
    project: string | null; reason: string | null; restored_from: number | null; created_at: number;
  }[];
  let prev: MetaSnapshot | null = null;
  const versions: SecretVersionDto[] = rows.map((r) => {
    const snap = JSON.parse(r.meta_snapshot) as MetaSnapshot;
    const dto: SecretVersionDto = {
      version: r.version,
      changedBy: actorRef(r.changed_by_type, r.changed_by_id, r.changed_by_name)!,
      project: r.project,
      reason: r.reason,
      metaDiff: metaDiff(prev, snap),
      restoredFrom: r.restored_from,
      createdAt: r.created_at,
    };
    prev = snap;
    return dto;
  });

  const evRows = db.$client
    .prepare(
      `SELECT event, ts, actor_type, actor_id, reason, project, ${NAME_OF('actor_name', 'actor_type', 'actor_id')}
         FROM audit_log WHERE secret_id = ? AND event IN ('secret.archived', 'secret.unarchived') ORDER BY seq ASC`,
    )
    .all(secretId) as { event: string; ts: number; actor_type: string; actor_id: string | null; actor_name: string | null; reason: string | null; project: string | null }[];
  const events = evRows.flatMap((e) => {
    const by = actorRef(e.actor_type, e.actor_id, e.actor_name);
    if (!by) return [];
    return [{
      type: e.event === 'secret.archived' ? ('archived' as const) : ('unarchived' as const),
      at: e.ts,
      by,
      ...(e.reason !== null ? { reason: e.reason } : {}),
      ...(e.project !== null ? { project: e.project } : {}),
    }];
  });
  return { versions: versions.reverse(), events };
}

export function listVersions(db: Db, userId: string, secretId: string): SecretVersionDto[] {
  return listHistory(db, userId, secretId).versions;
}
