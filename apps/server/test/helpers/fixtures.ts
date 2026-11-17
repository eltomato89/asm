import type { FastifyInstance } from 'fastify';
import { newId } from '@asm/shared';
import { createUser, type CreatedUser } from '../../src/auth/setup.js';
import type { Actor } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { devices } from '../../src/db/schema.js';
import type { ServiceCtx } from '../../src/context.js';
import { issueTokens } from '../../src/oauth/token.js';
import { bearerAuth } from '../../src/oauth/bearer.js';
import { createTestApp } from './testApp.js';

export const ORIGIN = 'https://asm.test';
export const PW = 'correct horse battery';

export type TestUser = CreatedUser & { cookie: string; actor: Actor };

export async function login(app: FastifyInstance, username: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PW } });
  const c = res.cookies.find((x) => x.name === 'asm_session');
  if (!c) throw new Error(`login failed: ${res.statusCode}`);
  return `asm_session=${c.value}`;
}

export async function addUser(t: { app: FastifyInstance; db: Db; clock: { now(): number } }, username: string, isAdmin = false): Promise<TestUser> {
  const u = await createUser(t.db, t.clock, { username, password: PW, isAdmin });
  const cookie = await login(t.app, username);
  return { ...u, cookie, actor: { type: 'user', userId: u.id } };
}

export function addDevice(db: Db, userId: string, name = 'laptop-mcp'): Actor & { type: 'device' } {
  const id = newId('dev');
  db.insert(devices).values({ id, userId, name, kind: 'mcp', status: 'approved', createdAt: 0 }).run();
  return { type: 'device', deviceId: id, userId };
}

/**
 * Creates an approved device for a user and issues tokens through the real token service
 * (same code path as /oauth/token).
 */
export function pairDevice(
  ctx: ServiceCtx,
  opts: { userId: string; kind: 'mcp' | 'cli'; name?: string },
): { deviceId: string; accessToken: string; refreshToken: string } {
  const deviceId = newId('dev');
  ctx.db
    .insert(devices)
    .values({ id: deviceId, userId: opts.userId, name: opts.name ?? `test-${opts.kind}`, kind: opts.kind, status: 'approved', createdAt: ctx.clock.now() })
    .run();
  const t = issueTokens(ctx, deviceId);
  return { deviceId, accessToken: t.accessToken, refreshToken: t.refreshToken };
}

/** Two users (alice admin, bob) with sessions. `beforeReady` may add routes before the first inject. */
export async function world(
  opts: { beforeReady?: (t: Awaited<ReturnType<typeof createTestApp>>) => void; app?: Parameters<typeof createTestApp>[0] } = {},
) {
  const t = await createTestApp(opts.app);
  opts.beforeReady?.(t);
  const alice = await addUser(t, 'alice', true);
  const bob = await addUser(t, 'bob');
  const req = (user: TestUser | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { ...(user ? { cookie: user.cookie } : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { ...t, alice, bob, req };
}

/** Recursively collects all object keys of a JSON value. */
export function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      acc.add(k);
      allKeys(child, acc);
    }
  }
  return acc;
}

export const FORBIDDEN_RESPONSE_KEYS = ['value', 'ciphertext', 'iv', 'tag', 'dek', 'wrappedDek', 'dekIv', 'dekTag', 'plaintext'];

export function auditRows(db: Db, event: string) {
  return db.$client.prepare('SELECT * FROM audit_log WHERE event = ? ORDER BY seq').all(event) as Record<string, unknown>[];
}

export const BEARER_PROBE = '/test/whoami';

/** Adds a test route guarded by bearerAuth that echoes req.device (use as world({ beforeReady })). */
export function addBearerProbe(t: { app: FastifyInstance; db: Db; clock: { now(): number }; config: { publicUrl: URL } }): void {
  t.app.get(BEARER_PROBE, { preHandler: bearerAuth({ db: t.db, clock: t.clock, publicOrigin: t.config.publicUrl.origin }) }, async (req) => req.device);
}

export const bearer = (app: FastifyInstance, token: string | undefined) =>
  app.inject({ method: 'GET', url: BEARER_PROBE, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
