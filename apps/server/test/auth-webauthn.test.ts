import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { WebAuthnAdapter } from '../src/auth/webauthn.js';
import { passkeys } from '../src/db/schema.js';
import { createUser } from '../src/auth/setup.js';
import type { Db } from '../src/db/client.js';
import { createTestApp } from './helpers/testApp.js';

const ORIGIN = 'https://asm.test';
const PW = 'correct horse battery';

function stubAdapter() {
  const a = {
    generateRegistrationOptions: vi.fn(async (_o: Record<string, any>) => ({ challenge: 'chal-reg' }) as never),
    verifyRegistration: vi.fn(async (_o: Record<string, any>) => ({
      verified: true as const,
      credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
    })),
    generateAuthenticationOptions: vi.fn(async (_o: Record<string, any>) => ({ challenge: 'chal-auth' }) as never),
    verifyAuthentication: vi.fn(async (_o: Record<string, any>) => ({ verified: true, newCounter: 1 })),
  } satisfies WebAuthnAdapter;
  return a;
}

async function boot() {
  const webauthn = stubAdapter();
  const t = await createTestApp({ webauthn });
  return { ...t, webauthn };
}

function cookieHeader(res: { cookies: { name: string; value: string }[] }, ...names: string[]): string {
  return names
    .map((n) => {
      const c = res.cookies.find((x) => x.name === n);
      if (!c) throw new Error(`no cookie ${n}`);
      return `${n}=${c.value}`;
    })
    .join('; ');
}

async function userWithSession(app: FastifyInstance, db: Db, clock: { now(): number }, opts: { password?: string } = { password: PW }) {
  const user = await createUser(db, clock as never, { username: 'alice', password: opts.password, isAdmin: true });
  if (!opts.password) {
    // no password: obtain a session directly
    const { createSession } = await import('../src/auth/sessions.js');
    return { user, cookie: `asm_session=${createSession(db, clock as never, user.id).token}` };
  }
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: opts.password } });
  return { user, cookie: cookieHeader(res, 'asm_session') };
}

const post = (app: FastifyInstance, url: string, cookie: string | undefined, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { ...(cookie ? { cookie } : {}), origin: ORIGIN }, payload: payload as object });

async function registerPasskey(app: FastifyInstance, cookie: string, name?: string) {
  const o = await post(app, '/api/auth/passkey/register/options', cookie);
  expect(o.statusCode).toBe(200);
  const c = cookieHeader(o, 'asm_webauthn');
  return post(app, '/api/auth/passkey/register/verify', `${cookie}; ${c}`, { name, response: { id: 'cred-1' } });
}

function auditEvents(db: Db, event: string) {
  return (db.$client.prepare('SELECT meta FROM audit_log WHERE event = ?').all(event) as { meta: string | null }[]).map((r) =>
    r.meta ? JSON.parse(r.meta) : null,
  );
}

describe('passkey registration', () => {
  it('requires a session', async () => {
    const { app } = await boot();
    expect((await post(app, '/api/auth/passkey/register/options', undefined)).statusCode).toBe(401);
  });

  it('options set a strict challenge cookie and request discoverable credentials; verify stores credential', async () => {
    const { app, db, clock, webauthn } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    const o = await post(app, '/api/auth/passkey/register/options', cookie);
    const c = o.cookies.find((x) => x.name === 'asm_webauthn')!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/auth' });
    const callArg = webauthn.generateRegistrationOptions.mock.calls[0]![0] as Record<string, any>;
    expect(callArg.rpID).toBe('asm.test');
    expect(callArg.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'preferred' });

    const v = await post(app, '/api/auth/passkey/register/verify', `${cookie}; asm_webauthn=${c.value}`, { name: 'Laptop', response: { id: 'x' } });
    expect(v.statusCode).toBe(201);
    const row = db.select().from(passkeys).get()!;
    expect(row).toMatchObject({ credentialId: 'cred-1', name: 'Laptop', counter: 0, transports: ['internal'] });
    expect(Buffer.from(row.publicKey)).toEqual(Buffer.from([1, 2, 3]));
    const verifyArg = webauthn.verifyRegistration.mock.calls[0]![0] as Record<string, any>;
    expect(verifyArg).toMatchObject({ expectedChallenge: 'chal-reg', expectedOrigin: ORIGIN, expectedRPID: 'asm.test' });
  });

  it('defaults name to "Passkey" and excludes existing credentials in the next options call', async () => {
    const { app, db, clock, webauthn } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    expect((await registerPasskey(app, cookie)).statusCode).toBe(201);
    expect(db.select().from(passkeys).get()!.name).toBe('Passkey');
    await post(app, '/api/auth/passkey/register/options', cookie);
    const arg = webauthn.generateRegistrationOptions.mock.calls[1]![0] as Record<string, any>;
    expect(arg.excludeCredentials).toEqual([{ id: 'cred-1', transports: ['internal'] }]);
  });

  it('challenge is one-time: second verify fails; missing cookie fails; failed verify consumes challenge', async () => {
    const { app, db, clock, webauthn } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    const o = await post(app, '/api/auth/passkey/register/options', cookie);
    const ch = cookieHeader(o, 'asm_webauthn');
    webauthn.verifyRegistration.mockResolvedValueOnce({ verified: false } as never);
    expect((await post(app, '/api/auth/passkey/register/verify', `${cookie}; ${ch}`, { response: {} })).statusCode).toBe(400);
    expect((await post(app, '/api/auth/passkey/register/verify', `${cookie}; ${ch}`, { response: {} })).statusCode).toBe(400);
    expect(webauthn.verifyRegistration).toHaveBeenCalledTimes(1);
    expect((await post(app, '/api/auth/passkey/register/verify', cookie, { response: {} })).statusCode).toBe(400);
    expect(db.select().from(passkeys).all()).toHaveLength(0);
  });

  it('challenge expires after 5 minutes', async () => {
    const { app, db, clock, webauthn } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    const o = await post(app, '/api/auth/passkey/register/options', cookie);
    clock.advance(5 * 60_000 + 1);
    const r = await post(app, '/api/auth/passkey/register/verify', `${cookie}; ${cookieHeader(o, 'asm_webauthn')}`, { response: {} });
    expect(r.statusCode).toBe(400);
    expect(webauthn.verifyRegistration).not.toHaveBeenCalled();
  });

  it('challenge from another user session is rejected', async () => {
    const { app, db, clock } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    await createUser(db, clock, { username: 'bob', password: PW, isAdmin: false });
    const bob = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: PW } });
    const bobCookie = cookieHeader(bob, 'asm_session');
    const o = await post(app, '/api/auth/passkey/register/options', cookie);
    const r = await post(app, '/api/auth/passkey/register/verify', `${bobCookie}; ${cookieHeader(o, 'asm_webauthn')}`, { response: {} });
    expect(r.statusCode).toBe(400);
  });
});

describe('passkey login', () => {
  async function withPasskey() {
    const t = await boot();
    const s = await userWithSession(t.app, t.db, t.clock);
    await registerPasskey(t.app, s.cookie);
    return { ...t, ...s };
  }
  async function loginOptions(app: FastifyInstance) {
    const o = await post(app, '/api/auth/passkey/login/options', undefined);
    expect(o.statusCode).toBe(200);
    return cookieHeader(o, 'asm_webauthn');
  }

  it('options are discoverable (no allowCredentials)', async () => {
    const { app, webauthn } = await withPasskey();
    await loginOptions(app);
    const arg = webauthn.generateAuthenticationOptions.mock.calls[0]![0] as Record<string, any>;
    expect(arg.allowCredentials).toBeUndefined();
    expect(arg).toMatchObject({ rpID: 'asm.test', userVerification: 'preferred' });
  });

  it('unknown credential id -> 401 invalid_credentials + audit', async () => {
    const { app, db } = await withPasskey();
    const ch = await loginOptions(app);
    const r = await post(app, '/api/auth/passkey/login/verify', ch, { response: { id: 'nope' } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'invalid_credentials' });
    expect(auditEvents(db, 'auth.login_failed')).toEqual([{ method: 'passkey' }]);
  });

  it('success sets session cookie, updates counter, audits, replaces old session', async () => {
    const { app, db, cookie, webauthn } = await withPasskey();
    const ch = await loginOptions(app);
    const r = await post(app, '/api/auth/passkey/login/verify', `${cookie}; ${ch}`, { response: { id: 'cred-1' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: 'alice', isAdmin: true });
    const sc = r.cookies.find((x) => x.name === 'asm_session')!;
    expect(sc).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
    expect(db.select().from(passkeys).get()!.counter).toBe(1);
    expect(auditEvents(db, 'auth.login')).toContainEqual({ method: 'passkey' });
    const arg = webauthn.verifyAuthentication.mock.calls[0]![0] as Record<string, any>;
    expect(arg).toMatchObject({ expectedChallenge: 'chal-auth', expectedOrigin: ORIGIN, expectedRPID: 'asm.test' });
    expect(arg.credential).toMatchObject({ id: 'cred-1', counter: 0 });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `asm_session=${sc.value}` } });
    expect(me.statusCode).toBe(200);
    const old = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(old.statusCode).toBe(401);
  });

  it('counter regression -> 401 and counter unchanged', async () => {
    const { app, db, webauthn } = await withPasskey();
    db.update(passkeys).set({ counter: 5 }).where(eq(passkeys.credentialId, 'cred-1')).run();
    webauthn.verifyAuthentication.mockResolvedValueOnce({ verified: true, newCounter: 5 });
    const r = await post(app, '/api/auth/passkey/login/verify', await loginOptions(app), { response: { id: 'cred-1' } });
    expect(r.statusCode).toBe(401);
    expect(db.select().from(passkeys).get()!.counter).toBe(5);
    expect(auditEvents(db, 'auth.login_failed')).toEqual([{ method: 'passkey' }]);
  });

  it('counters staying 0 (authenticators without counter) are allowed', async () => {
    const { app, webauthn } = await withPasskey();
    webauthn.verifyAuthentication.mockResolvedValueOnce({ verified: true, newCounter: 0 });
    const r = await post(app, '/api/auth/passkey/login/verify', await loginOptions(app), { response: { id: 'cred-1' } });
    expect(r.statusCode).toBe(200);
  });

  it('failed verification -> 401; challenge cannot be replayed; missing challenge -> 401', async () => {
    const { app, webauthn } = await withPasskey();
    const ch = await loginOptions(app);
    webauthn.verifyAuthentication.mockResolvedValueOnce({ verified: false, newCounter: 0 });
    expect((await post(app, '/api/auth/passkey/login/verify', ch, { response: { id: 'cred-1' } })).statusCode).toBe(401);
    expect((await post(app, '/api/auth/passkey/login/verify', ch, { response: { id: 'cred-1' } })).statusCode).toBe(401);
    expect((await post(app, '/api/auth/passkey/login/verify', undefined, { response: { id: 'cred-1' } })).statusCode).toBe(401);
    expect(webauthn.verifyAuthentication).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign Origin', async () => {
    const { app } = await withPasskey();
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/options', headers: { origin: 'https://evil.test' }, payload: {} });
    expect(r.statusCode).toBe(403);
  });
});

describe('passkey reauth', () => {
  it('only accepts the session user\'s credentials and touches reauth', async () => {
    const { app, db, clock, webauthn } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    await registerPasskey(app, cookie);
    clock.advance(11 * 60_000);
    const o = await post(app, '/api/auth/reauth/passkey/options', cookie);
    expect(o.statusCode).toBe(200);
    const arg = webauthn.generateAuthenticationOptions.mock.calls[0]![0] as Record<string, any>;
    expect(arg.allowCredentials).toEqual([{ id: 'cred-1', transports: ['internal'] }]);
    const ok = await post(app, '/api/auth/reauth/passkey/verify', `${cookie}; ${cookieHeader(o, 'asm_webauthn')}`, { response: { id: 'cred-1' } });
    expect(ok.statusCode).toBe(200);
    const row = db.$client.prepare('SELECT last_auth_at FROM sessions').get() as { last_auth_at: number };
    expect(row.last_auth_at).toBe(clock.now());
  });

  it('rejects another user\'s credential', async () => {
    const { app, db, clock } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    await registerPasskey(app, cookie);
    await createUser(db, clock, { username: 'bob', password: PW, isAdmin: false });
    const bob = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: PW } });
    const bobCookie = cookieHeader(bob, 'asm_session');
    db.insert(passkeys).values({ id: 'pky_bob', userId: (db.$client.prepare("SELECT id FROM users WHERE username='bob'").get() as { id: string }).id, credentialId: 'cred-bob', publicKey: Buffer.from([9]), counter: 0, transports: null, name: 'b', createdAt: 1 }).run();
    const o = await post(app, '/api/auth/reauth/passkey/options', bobCookie);
    const r = await post(app, '/api/auth/reauth/passkey/verify', `${bobCookie}; ${cookieHeader(o, 'asm_webauthn')}`, { response: { id: 'cred-1' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('passkey management', () => {
  it('lists id, name, createdAt, transports only', async () => {
    const { app, db, clock } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    await registerPasskey(app, cookie, 'Phone');
    const r = await app.inject({ method: 'GET', url: '/api/auth/passkeys', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const list = r.json() as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual(['createdAt', 'id', 'name', 'transports']);
    expect(list[0]).toMatchObject({ name: 'Phone', transports: ['internal'] });
  });

  it('deleting the last passkey of a password-less user -> 409 last_credential', async () => {
    const { app, db, clock } = await boot();
    const { cookie } = await userWithSession(app, db, clock, {});
    await registerPasskey(app, cookie);
    const id = db.select().from(passkeys).get()!.id;
    const r = await app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${id}`, headers: { cookie, origin: ORIGIN } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'last_credential' });
    expect(db.select().from(passkeys).all()).toHaveLength(1);
  });

  it('deleting the last passkey is fine when a password exists; foreign/unknown ids 404', async () => {
    const { app, db, clock } = await boot();
    const { cookie } = await userWithSession(app, db, clock);
    await registerPasskey(app, cookie);
    const id = db.select().from(passkeys).get()!.id;
    const other = await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/pky_nope', headers: { cookie, origin: ORIGIN } });
    expect(other.statusCode).toBe(404);
    const r = await app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${id}`, headers: { cookie, origin: ORIGIN } });
    expect(r.statusCode).toBe(200);
    expect(db.select().from(passkeys).all()).toHaveLength(0);
  });
});
