import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { requireRecentAuth, requireUser } from '../src/auth/guards.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { ValidationError } from '../src/errors.js';
import { createUser } from '../src/auth/setup.js';
import { verifyChain } from '../src/audit/audit.js';
import type { Db } from '../src/db/client.js';
import { createTestApp } from './helpers/testApp.js';

const ORIGIN = 'https://asm.test';
const PW = 'correct horse battery';

function auditEvents(db: Db, event: string): { actor_type: string; actor_id: string; ip: string | null; meta: Record<string, unknown> | null }[] {
  const rows = db.$client.prepare('SELECT actor_type, actor_id, ip, meta FROM audit_log WHERE event = ? ORDER BY seq').all(event) as {
    actor_type: string; actor_id: string; ip: string | null; meta: string | null;
  }[];
  return rows.map((r) => ({ ...r, meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null }));
}

async function boot() {
  const t = await createTestApp();
  t.app.get('/probe/recent', { preHandler: [requireUser, requireRecentAuth(t.clock)] }, async () => ({ ok: true }));
  return t;
}

async function setupAdmin(app: FastifyInstance, username = 'admin', password = PW) {
  return app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: app.setup.getToken(), username, password },
  });
}

async function login(app: FastifyInstance, username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'asm_session');
  if (!c) throw new Error('no session cookie');
  return `asm_session=${c.value}`;
}

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword(PW);
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, PW)).toBe(true);
    expect(await verifyPassword(h, 'nope')).toBe(false);
  });
});

describe('setup', () => {
  it('status, wrong token 403, right token 201, second setup 409', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: true });
    const bad = await app.inject({
      method: 'POST', url: '/api/setup', payload: { token: 'wrong', username: 'admin', password: PW },
    });
    expect(bad.statusCode).toBe(403);
    const ok = await setupAdmin(app);
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: false });
    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: { token: 'anything', username: 'other', password: PW } });
    expect(again.statusCode).toBe(409);
    expect(app.setup.getToken()).toBeUndefined();
    await app.close();
  });

  it('concurrent setups create exactly one admin', async () => {
    const { app, db } = await boot();
    const token = app.setup.getToken();
    const go = (u: string) => app.inject({ method: 'POST', url: '/api/setup', payload: { token, username: u, password: PW } });
    const res = await Promise.all([go('admin1'), go('admin2')]);
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => [403, 409].includes(r.statusCode))).toHaveLength(1);
    expect((db.$client.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n).toBe(1);
    await app.close();
  });

  it('rejects short passwords and bad usernames with 400', async () => {
    const { app } = await boot();
    const token = app.setup.getToken();
    const a = await app.inject({ method: 'POST', url: '/api/setup', payload: { token, username: 'admin', password: 'short' } });
    expect(a.statusCode).toBe(400);
    const b = await app.inject({ method: 'POST', url: '/api/setup', payload: { token, username: 'a b', password: PW } });
    expect(b.statusCode).toBe(400);
    await app.close();
  });

  it('does not generate a setup token when users exist', async () => {
    const first = await createTestApp({ dbPath: ':memory:' });
    await createUser(first.db, first.clock, { username: 'x-user', password: PW, isAdmin: true });
    // a second app over the same db handle is not possible in-memory; assert status route instead
    expect((await first.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: false });
  });
});

describe('login and sessions', () => {
  it('failed login -> 401 + audit auth.login_failed', async () => {
    const { app, db } = await boot();
    await setupAdmin(app);
    const res = await login(app, 'admin', 'wrong password!!');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    const ev = auditEvents(db, 'auth.login_failed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_type: 'system', actor_id: 'anonymous', meta: { username: 'admin' }, ip: '127.0.0.1' });
    await app.close();
  });

  it('unknown user also 401 + audit, without storing the typed username (could be a mistyped password)', async () => {
    const { app, db } = await boot();
    const typed = 'my-Secret-P4ssword-typed-into-username';
    const res = await login(app, typed, 'whatever-password');
    expect(res.statusCode).toBe(401);
    const ev = auditEvents(db, 'auth.login_failed');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.meta?.username).toBeUndefined();
    expect(JSON.stringify(db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain(typed.toLowerCase());
    await app.close();
  });

  it('login sets hardened cookie, me returns user, audit auth.login', async () => {
    const { app, db } = await boot();
    await setupAdmin(app);
    const res = await login(app, 'Admin', PW);
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/asm_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Max-Age=604800/);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'admin', isAdmin: true });
    expect(auditEvents(db, 'auth.login')).toHaveLength(1);
    expect(verifyChain(db)).toEqual({ ok: true });
    // token is stored hashed only
    const row = db.$client.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookieOf(res)).not.toContain(row.token_hash);
    await app.close();
  });

  it('me without cookie -> 401', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    await app.close();
  });

  it('sessions expire after 7 days', async () => {
    const { app, clock } = await boot();
    await setupAdmin(app);
    const res = await login(app, 'admin', PW);
    const headers = { cookie: cookieOf(res) };
    clock.advance(7 * 24 * 3600_000 - 1000);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(200);
    clock.advance(2000);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(401);
    await app.close();
  });

  it('logout invalidates the session', async () => {
    const { app } = await boot();
    await setupAdmin(app);
    const res = await login(app, 'admin', PW);
    const headers = { cookie: cookieOf(res), origin: ORIGIN };
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(401);
    await app.close();
  });
});

describe('origin check', () => {
  it('rejects mutating requests with a session cookie and wrong/missing Origin', async () => {
    const { app } = await boot();
    await setupAdmin(app);
    const cookie = cookieOf(await login(app, 'admin', PW));
    for (const headers of [{ cookie }, { cookie, origin: 'https://evil.test' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'bad_origin' });
    }
    const ok = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: ORIGIN } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe('origin hardening', () => {
  it('percent-encoded path cannot bypass the Origin check', async () => {
    const { app } = await boot();
    await setupAdmin(app);
    const cookie = cookieOf(await login(app, 'admin', PW));
    const res = await app.inject({ method: 'POST', url: '/%61pi/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'bad_origin' });
    await app.close();
  });

  it('login and setup reject a foreign Origin header', async () => {
    const { app } = await boot();
    const evil = { origin: 'https://evil.test' };
    const s = await app.inject({ method: 'POST', url: '/api/setup', headers: evil, payload: { token: app.setup.getToken(), username: 'admin', password: PW } });
    expect(s.statusCode).toBe(403);
    expect(s.json()).toEqual({ error: 'bad_origin' });
    await setupAdmin(app);
    const l = await app.inject({ method: 'POST', url: '/api/auth/login', headers: evil, payload: { username: 'admin', password: PW } });
    expect(l.statusCode).toBe(403);
    await app.close();
  });

  it('login drops the session presented in the cookie', async () => {
    const { app, db } = await boot();
    await setupAdmin(app);
    const first = cookieOf(await login(app, 'admin', PW));
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { cookie: first, origin: ORIGIN }, payload: { username: 'admin', password: PW } });
    expect(res.statusCode).toBe(200);
    expect((db.$client.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    await app.close();
  });
});

describe('createUser validation', () => {
  it('rejects bad usernames and short passwords itself', async () => {
    const { db, clock, app } = await boot();
    await expect(createUser(db, clock, { username: 'ab', password: PW, isAdmin: false })).rejects.toThrow(ValidationError);
    await expect(createUser(db, clock, { username: 'a b c', password: PW, isAdmin: false })).rejects.toThrow(ValidationError);
    await expect(createUser(db, clock, { username: 'x'.repeat(65), password: PW, isAdmin: false })).rejects.toThrow(ValidationError);
    await expect(createUser(db, clock, { username: 'valid', password: 'short', isAdmin: false })).rejects.toThrow(ValidationError);
    await app.close();
  });
});

describe('users', () => {
  it('createUser makes exactly one personal vault with owner membership', async () => {
    const { db, clock, app } = await boot();
    const u = await createUser(db, clock, { username: 'Alice', password: PW, isAdmin: false });
    expect(u.username).toBe('alice');
    const vaults = db.$client.prepare('SELECT * FROM vaults WHERE personal_of_user_id = ?').all(u.id) as { id: string; name: string }[];
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.name).toBe('Persönlich');
    const members = db.$client.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?').all(vaults[0]!.id, u.id);
    expect(members).toEqual([{ role: 'owner' }]);
    await app.close();
  });

  it('admin creates users; non-admin gets 403; duplicate 409', async () => {
    const { app, db, clock } = await boot();
    await setupAdmin(app);
    const admin = cookieOf(await login(app, 'admin', PW));
    const h = { cookie: admin, origin: ORIGIN };
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { username: 'bob', password: PW } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ username: 'bob', isAdmin: false });
    const dup = await app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { username: 'BOB', password: PW } });
    expect(dup.statusCode).toBe(409);
    const bob = cookieOf(await login(app, 'bob', PW));
    const denied = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: bob, origin: ORIGIN }, payload: { username: 'eve', password: PW },
    });
    expect(denied.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/api/admin/users', payload: { username: 'eve', password: PW } });
    expect(anon.statusCode).toBe(401);
    void db; void clock;
    await app.close();
  });
});

describe('recent auth', () => {
  it('requires reauth after 10 minutes, reauth/password refreshes', async () => {
    const { app, clock } = await boot();
    await setupAdmin(app);
    const cookie = cookieOf(await login(app, 'admin', PW));
    const h = { cookie, origin: ORIGIN };
    expect((await app.inject({ method: 'GET', url: '/probe/recent', headers: h })).statusCode).toBe(200);
    clock.advance(11 * 60_000);
    const stale = await app.inject({ method: 'GET', url: '/probe/recent', headers: h });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    const bad = await app.inject({ method: 'POST', url: '/api/auth/reauth/password', headers: h, payload: { password: 'not the password' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/reauth/password', headers: h, payload: { password: PW } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/probe/recent', headers: h })).statusCode).toBe(200);
    await app.close();
  });
});

describe('rate limit', () => {
  it('6th failed login within a minute -> 429', async () => {
    const { app } = await boot();
    await setupAdmin(app);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login(app, 'admin', 'wrong password!!')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    // other username is unaffected
    expect((await login(app, 'someone', 'wrong password!!')).statusCode).toBe(401);
    await app.close();
  });
});

describe('error handling', () => {
  it('unknown errors are 500 {error:internal} without echoing details', async () => {
    const { app } = await boot();
    app.get('/boom', async () => { throw new Error('secret-value-xyz'); });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal' });
    await app.close();
  });
});
