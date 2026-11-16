import type { ActorRef, SecretHistory, SecretMeta, SecretVersionDto } from '@asm/shared';
import type { Actor, RequestInfo, ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import type { MetaSnapshot } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { applySecretChange, loadAccessible, openVersion, same, SNAPSHOT_FIELDS, userOnly } from './service.js';

/** Applies the value + metadata of an old version as a new version with `restoredFrom`. */
export function restoreVersion(ctx: ServiceCtx, actor: Actor, secretId: string, version: number, info: RequestInfo = {}): SecretMeta {
  userOnly(actor);
  // applySecretChange's transaction nests as a savepoint.
  return ctx.db.$client.transaction((): SecretMeta => {
    const row = loadAccessible(ctx.db, actor.userId, secretId);
    if (row.archived_at !== null) throw new HttpError(409, 'secret_archived');
    const old = openVersion(ctx, secretId, version);
    return applySecretChange(ctx, actor, secretId, { value: old.plaintext, meta: old.snapshot, restoredFrom: version }, info);
  })();
}

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
