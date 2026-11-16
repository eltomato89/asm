import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { appendAudit } from '../audit/audit.js';
import { sessions, users } from '../db/schema.js';
import { HttpError, ValidationError } from '../errors.js';
import { checkLoginOrigin, requireAdmin, requireRecentAuth, requireUser } from './guards.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, SESSION_COOKIE_ATTRS, createSession, deleteSession, setSessionCookie, touchReauth } from './sessions.js';
import { registerPasskeyRoutes } from './webauthn.js';
import { MIN_PASSWORD_LENGTH, USERNAME_RE, countUsers, createUser } from './setup.js';

const username = z.string().min(3).max(64).regex(USERNAME_RE);
const newPassword = z.string().min(MIN_PASSWORD_LENGTH).max(1024);
const anyPassword = z.string().min(1).max(1024);

const setupBody = z.object({ token: z.string().min(1).max(256), username, password: newPassword });
const loginBody = z.object({ username: z.string().min(1).max(256), password: anyPassword });
const reauthBody = z.object({ password: anyPassword });
const adminCreateBody = z.object({ username, password: newPassword.optional(), isAdmin: z.boolean().default(false) });
const passwordChangeBody = z.strictObject({ currentPassword: anyPassword.optional(), newPassword });

// Hash of a random password; verified against when the user is unknown to equalize timing.
const dummyHash = hashPassword('asm-dummy-password-for-timing');

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, clock, config } = deps;

  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler', // body is parsed, so the key can include the username
    errorResponseBuilder: () => new HttpError(429, 'rate_limited'),
  });
  const limited = (nameOf: (req: FastifyRequest) => string) => ({
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => `${req.ip}|${nameOf(req).toLowerCase().slice(0, 64)}`,
    },
  });
  const bodyField = (field: string) => (req: FastifyRequest) => {
    const v = (req.body as Record<string, unknown> | null | undefined)?.[field];
    return typeof v === 'string' ? v : '';
  };

  const checkOrigin = (req: FastifyRequest) => checkLoginOrigin(req, config.publicUrl.origin);

  app.get('/api/setup/status', async () => ({ needsSetup: countUsers(db) === 0 }));

  app.post('/api/setup', { config: limited(bodyField('username')) }, async (req, reply) => {
    checkOrigin(req);
    const body = setupBody.parse(req.body);
    if (countUsers(db) > 0) throw new HttpError(409, 'already_setup');
    if (!app.setup.verify(body.token)) throw new HttpError(403, 'invalid_setup_token');
    // Consume the token synchronously (before any await) so concurrent requests cannot reuse it.
    const consumed = app.setup.getToken();
    app.setup.clear();
    let user;
    try {
      user = await createUser(db, clock, { username: body.username, password: body.password, isAdmin: true }, { onlyIfNoUsers: true });
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'already_setup')) app.setup.restore(consumed);
      throw e;
    }
    return reply.status(201).send({ id: user.id, username: user.username, isAdmin: true });
  });

  app.post('/api/auth/login', { config: limited(bodyField('username')) }, async (req, reply) => {
    checkOrigin(req);
    const body = loginBody.parse(req.body);
    const name = body.username.toLowerCase();
    const row = db.select().from(users).where(eq(users.username, name)).get();
    const ok = row?.passwordHash
      ? await verifyPassword(row.passwordHash, body.password)
      : (await verifyPassword(await dummyHash, body.password), false);
    if (!row || !ok) {
      appendAudit(db, clock, {
        actorType: 'system',
        actorId: 'anonymous',
        event: 'auth.login_failed',
        ip: req.ip,
        meta: { username: name.slice(0, 64) },
      });
      throw new HttpError(401, 'invalid_credentials');
    }
    if (req.session) deleteSession(db, req.session.id);
    const { token } = createSession(db, clock, row.id);
    appendAudit(db, clock, { actorType: 'user', actorId: row.id, event: 'auth.login', ip: req.ip });
    setSessionCookie(reply, token);
    return { id: row.id, username: row.username, isAdmin: row.isAdmin };
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    deleteSession(db, req.session!.id);
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_ATTRS);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => req.user);

  app.post(
    '/api/auth/reauth/password',
    { preHandler: requireUser, config: limited((req) => req.user?.id ?? '') },
    async (req) => {
      const body = reauthBody.parse(req.body);
      const row = db.select().from(users).where(eq(users.id, req.user!.id)).get();
      if (!row?.passwordHash || !(await verifyPassword(row.passwordHash, body.password))) {
        throw new HttpError(401, 'invalid_credentials');
      }
      touchReauth(db, clock, req.session!.id);
      return { ok: true };
    },
  );

  // Change (or first set) the own password. Ends every other session of the user; the current one stays.
  app.post(
    '/api/auth/password',
    { preHandler: [requireUser, requireRecentAuth(clock)], config: limited((req) => req.user?.id ?? '') },
    async (req) => {
      const body = passwordChangeBody.parse(req.body);
      const userId = req.user!.id;
      const row = db.select().from(users).where(eq(users.id, userId)).get();
      if (row?.passwordHash) {
        if (body.currentPassword === undefined) throw new ValidationError('current_password_required');
        if (!(await verifyPassword(row.passwordHash, body.currentPassword))) throw new HttpError(401, 'invalid_credentials');
      }
      const hash = await hashPassword(body.newPassword);
      db.$client.transaction(() => {
        db.update(users).set({ passwordHash: hash }).where(eq(users.id, userId)).run();
        db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, req.session!.id))).run();
      })();
      return { ok: true };
    },
  );

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    const rows = db.$client
      .prepare(
        `SELECT u.id, u.username, u.is_admin, u.created_at, u.password_hash IS NOT NULL AS has_password,
                (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
           FROM users u ORDER BY u.username`,
      )
      .all() as { id: string; username: string; is_admin: number; created_at: number; has_password: number; passkey_count: number }[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        isAdmin: r.is_admin === 1,
        createdAt: r.created_at,
        hasPassword: r.has_password === 1,
        passkeyCount: r.passkey_count,
      })),
    };
  });

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = adminCreateBody.parse(req.body);
    const user = await createUser(db, clock, body);
    return reply.status(201).send({ id: user.id, username: user.username, isAdmin: user.isAdmin });
  });

  registerPasskeyRoutes(app, deps, { limited, checkOrigin });
}
