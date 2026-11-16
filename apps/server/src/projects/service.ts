import { newId, ProjectNameSchema, type ProjectDetail, type ProjectDto, type SecretMeta } from '@asm/shared';
import { eq } from 'drizzle-orm';
import type { ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { HttpError, ValidationError } from '../errors.js';
import { getSecretMeta, secretMetasByIds } from '../secrets/service.js';
import { projectSlug } from './slug.js';

export type Project = typeof projects.$inferSelect;

const MAX_CHAIN = 100;

function toDto(p: Project): ProjectDto {
  return { id: p.id, slug: p.slug, displayName: p.displayName, mergedInto: p.mergedInto, firstSeen: p.firstSeen, lastSeen: p.lastSeen };
}

function byId(db: Db, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

/** Follows merged_into to the canonical project. */
export function resolveProject(db: Db, id: string): Project | undefined {
  let p = byId(db, id);
  for (let i = 0; p?.mergedInto && i < MAX_CHAIN; i++) p = byId(db, p.mergedInto);
  return p;
}

/** Creates the project for `name` or bumps last_seen; returns the canonical (merge-resolved) project. */
export function touchProject(ctx: ServiceCtx, name: string): Project {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new ValidationError('invalid_project');
  const slug = projectSlug(parsed.data);
  const now = ctx.clock.now();
  const db = ctx.db;
  return db.$client.transaction((): Project => {
    const existing = db.select().from(projects).where(eq(projects.slug, slug)).get();
    if (!existing) {
      const p: Project = { id: newId('prj'), slug, displayName: parsed.data, mergedInto: null, firstSeen: now, lastSeen: now };
      db.insert(projects).values(p).run();
      return p;
    }
    const canonical = resolveProject(db, existing.id) ?? existing;
    db.update(projects).set({ lastSeen: now }).where(eq(projects.id, existing.id)).run();
    db.update(projects).set({ lastSeen: now }).where(eq(projects.id, canonical.id)).run();
    return { ...canonical, lastSeen: now };
  })();
}

export function recordUsage(ctx: ServiceCtx, projectId: string, secretId: string, deviceId: string): void {
  ctx.db.$client
    .prepare(
      `INSERT INTO project_usage (project_id, secret_id, device_id, last_used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, secret_id, device_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
    )
    .run(projectId, secretId, deviceId, ctx.clock.now());
}

// A project is visible to a user only through usage on a secret in one of their vaults or by one of their devices.
const VISIBLE = `EXISTS (
  SELECT 1 FROM project_usage u
   WHERE u.project_id = p.id
     AND (u.device_id IN (SELECT id FROM devices WHERE user_id = @userId)
          OR u.secret_id IN (SELECT s.id FROM secrets s JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = @userId)))`;

type ProjectRow = { id: string; slug: string; display_name: string; merged_into: string | null; first_seen: number; last_seen: number };
const fromRow = (r: ProjectRow): Project => ({
  id: r.id, slug: r.slug, displayName: r.display_name, mergedInto: r.merged_into, firstSeen: r.first_seen, lastSeen: r.last_seen,
});

/** Canonical project if visible to the user, else 404 (no existence oracle). */
function visibleProject(db: Db, userId: string, id: string): Project {
  const p = resolveProject(db, id);
  const ok = p && db.$client.prepare(`SELECT 1 FROM projects p WHERE p.id = @id AND ${VISIBLE}`).get({ id: p.id, userId });
  if (!p || !ok) throw new HttpError(404, 'not_found');
  return p;
}

/** Non-merged projects visible to the user. */
export function listProjects(db: Db, userId: string): ProjectDto[] {
  const rows = db.$client
    .prepare(`SELECT p.* FROM projects p WHERE p.merged_into IS NULL AND ${VISIBLE} ORDER BY p.last_seen DESC, p.id`)
    .all({ userId }) as ProjectRow[];
  return rows.map((r) => toDto(fromRow(r)));
}

type UsageRow = { secret_id: string; device_id: string; device_name: string; device_kind: 'mcp' | 'cli'; last_used_at: number };

/** Usage of the project, restricted to secrets in vaults the user is a member of. */
export function getProject(db: Db, userId: string, id: string): ProjectDetail {
  const project = visibleProject(db, userId, id);
  const rows = db.$client
    .prepare(
      `SELECT u.secret_id, u.device_id, d.name AS device_name, d.kind AS device_kind, u.last_used_at
         FROM project_usage u
         JOIN secrets s ON s.id = u.secret_id
         JOIN vault_members m ON m.vault_id = s.vault_id AND m.user_id = ?
         JOIN devices d ON d.id = u.device_id
        WHERE u.project_id = ?
        ORDER BY u.last_used_at DESC`,
    )
    .all(userId, project.id) as UsageRow[];

  const secretLast = new Map<string, number>();
  const deviceLast = new Map<string, { id: string; name: string; kind: 'mcp' | 'cli'; last: number }>();
  for (const r of rows) {
    if (!secretLast.has(r.secret_id)) secretLast.set(r.secret_id, r.last_used_at);
    if (!deviceLast.has(r.device_id)) deviceLast.set(r.device_id, { id: r.device_id, name: r.device_name, kind: r.device_kind, last: r.last_used_at });
  }
  const metas = new Map(secretMetasByIds(db, userId, [...secretLast.keys()]).map((m): [string, SecretMeta] => [m.id, m]));
  return {
    project: toDto(project),
    secrets: [...secretLast].flatMap(([sid, lastUsedAt]) => {
      const secret = metas.get(sid);
      return secret ? [{ secret, lastUsedAt }] : [];
    }),
    devices: [...deviceLast.values()].map((d) => ({ device: { id: d.id, name: d.name, kind: d.kind }, lastUsedAt: d.last })),
  };
}

/** Both projects must be visible to the user (else 404). Marks `from` as merged into `into` and moves its usage rows. Audit rows keep their original project string. */
export function mergeProjects(ctx: ServiceCtx, userId: string, fromId: string, intoId: string): ProjectDto {
  const db = ctx.db;
  return db.$client.transaction((): ProjectDto => {
    const from = visibleProject(db, userId, fromId);
    const into = visibleProject(db, userId, intoId);
    if (from.id === into.id) throw new ValidationError('same_project');
    db.$client
      .prepare(
        `INSERT INTO project_usage (project_id, secret_id, device_id, last_used_at)
           SELECT ?, secret_id, device_id, last_used_at FROM project_usage WHERE project_id = ? AND true
         ON CONFLICT (project_id, secret_id, device_id) DO UPDATE SET last_used_at = max(last_used_at, excluded.last_used_at)`,
      )
      .run(into.id, from.id);
    db.$client.prepare('DELETE FROM project_usage WHERE project_id = ?').run(from.id);
    db.update(projects).set({ mergedInto: into.id }).where(eq(projects.id, from.id)).run();
    const lastSeen = Math.max(from.lastSeen, into.lastSeen);
    const firstSeen = Math.min(from.firstSeen, into.firstSeen);
    db.update(projects).set({ lastSeen, firstSeen }).where(eq(projects.id, into.id)).run();
    return toDto({ ...into, lastSeen, firstSeen });
  })();
}

/** Projects that used the secret (404 if the user cannot access it). */
export function projectsForSecret(db: Db, userId: string, secretId: string): { project: ProjectDto; lastUsedAt: number }[] {
  getSecretMeta(db, userId, secretId);
  const rows = db.$client
    .prepare('SELECT project_id, max(last_used_at) AS last FROM project_usage WHERE secret_id = ? GROUP BY project_id ORDER BY last DESC')
    .all(secretId) as { project_id: string; last: number }[];
  return rows.flatMap((r) => {
    const p = byId(db, r.project_id);
    return p ? [{ project: toDto(p), lastUsedAt: r.last }] : [];
  });
}
