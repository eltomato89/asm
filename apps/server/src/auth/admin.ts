import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import { devices, sessions, users } from '../db/schema.js';
import { revokeDevice } from '../devices/service.js';
import { HttpError } from '../errors.js';
import { reqInfo } from '../secrets/routes.js';
import { requireAdmin, requireRecentAuth } from './guards.js';
import { MIN_PASSWORD_LENGTH, USERNAME_RE, createUser } from './setup.js';

export type AdminUserDto = {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  hasPassword: boolean;
  passkeyCount: number;
  disabledAt: number | null;
};

type AdminUserRow = {
  id: string; username: string; is_admin: number; created_at: number; has_password: number; passkey_count: number; disabled_at: number | null;
};

const ADMIN_USER_SELECT = `
  SELECT u.id, u.username, u.is_admin, u.created_at, u.disabled_at, u.password_hash IS NOT NULL AS has_password,
         (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
    FROM users u`;

const toDto = (r: AdminUserRow): AdminUserDto => ({
  id: r.id,
  username: r.username,
  isAdmin: r.is_admin === 1,
  createdAt: r.created_at,
  hasPassword: r.has_password === 1,
  passkeyCount: r.passkey_count,
  disabledAt: r.disabled_at,
});

export function listUsers(ctx: ServiceCtx): AdminUserDto[] {
  return (ctx.db.$client.prepare(`${ADMIN_USER_SELECT} ORDER BY u.username`).all() as AdminUserRow[]).map(toDto);
}

function getUser(ctx: ServiceCtx, userId: string): AdminUserDto {
  const row = ctx.db.$client.prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`).get(userId) as AdminUserRow | undefined;
  if (!row) throw new HttpError(404, 'not_found');
  return toDto(row);
}

/**
 * Offboarding: marks the user disabled, deletes all their sessions and revokes all their devices (tokens, codes,
 * grants and open requests via revokeDevice, audited as device.revoked by the admin). Login (password and passkey),
 * sessions and bearer tokens of a disabled user are rejected. Idempotent.
 * 409 cannot_disable_self | 409 last_admin (the last active admin) | 404 not_found.
 */
export function disableUser(ctx: ServiceCtx, adminId: string, userId: string, info: RequestInfo = {}): AdminUserDto {
  const { db } = ctx;
  if (adminId === userId) throw new HttpError(409, 'cannot_disable_self');
  db.$client.transaction(() => {
    const target = db.select().from(users).where(eq(users.id, userId)).get();
    if (!target) throw new HttpError(404, 'not_found');
    if (target.disabledAt === null && target.isAdmin) {
      const others = db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, userId)))
        .get();
      if ((others?.n ?? 0) === 0) throw new HttpError(409, 'last_admin');
    }
    if (target.disabledAt === null) db.update(users).set({ disabledAt: ctx.clock.now() }).where(eq(users.id, userId)).run();
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
    const own = db.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), ne(devices.status, 'revoked'))).all();
    for (const d of own) revokeDevice(ctx, d.id, { type: 'user', userId: adminId }, info);
  })();
  return getUser(ctx, userId);
}

/** Re-enables login. Revoked devices stay revoked (they must be paired again). */
export function enableUser(ctx: ServiceCtx, userId: string): AdminUserDto {
  getUser(ctx, userId);
  ctx.db.update(users).set({ disabledAt: null }).where(eq(users.id, userId)).run();
  return getUser(ctx, userId);
}

const idParams = z.object({ id: z.string().min(1).max(100) });
const createBody = z.object({
  username: z.string().min(3).max(64).regex(USERNAME_RE),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024).optional(),
  isAdmin: z.boolean().default(false),
});

export async function registerAdminRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;
  const recentAdmin = [requireAdmin, requireRecentAuth(clock)];

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({ items: listUsers(ctx) }));

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const user = await createUser(ctx.db, clock, createBody.parse(req.body));
    return reply.status(201).send({ id: user.id, username: user.username, isAdmin: user.isAdmin });
  });

  app.post('/api/admin/users/:id/disable', { preHandler: recentAdmin }, async (req) =>
    disableUser(ctx, req.user!.id, idParams.parse(req.params).id, reqInfo(req)),
  );

  app.post('/api/admin/users/:id/enable', { preHandler: recentAdmin }, async (req) => enableUser(ctx, idParams.parse(req.params).id));
}
