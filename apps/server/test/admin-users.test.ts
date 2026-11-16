import { describe, expect, it, vi } from 'vitest';
import type { WebAuthnAdapter } from '../src/auth/webauthn.js';
import { disableUser } from '../src/auth/admin.js';
import { passkeys } from '../src/db/schema.js';
import { HttpError } from '../src/errors.js';
import { createRequest } from '../src/requests/service.js';
import { createSecret } from '../src/secrets/service.js';
import { ORIGIN, PW, addBearerProbe, auditRows, bearer, login, pairDevice, world } from './helpers/fixtures.js';

const MIN11 = 11 * 60_000;

function stubWebAuthn() {
  let counter = 0;
  return {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: 'chal-reg' }) as never),
    verifyRegistration: vi.fn(async () => ({ verified: false as const })),
    generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'chal-auth' }) as never),
    verifyAuthentication: vi.fn(async () => ({ verified: true, newCounter: ++counter })),
  } satisfies WebAuthnAdapter;
}

async function setup() {
  const w = await world({ beforeReady: addBearerProbe, app: { webauthn: stubWebAuthn() } });
  w.db.insert(passkeys).values({ id: 'pky_b', userId: w.bob.id, credentialId: 'cred-bob', publicKey: Buffer.from([1]), counter: 0, transports: null, name: 'p', createdAt: 1 }).run();
  return w;
}

type W = Awaited<ReturnType<typeof setup>>;

async function passkeyLogin(w: W) {
  const o = await w.app.inject({ method: 'POST', url: '/api/auth/passkey/login/options', headers: { origin: ORIGIN } });
  const c = o.cookies.find((x) => x.name === 'asm_webauthn')!;
  return w.app.inject({
    method: 'POST', url: '/api/auth/passkey/login/verify', headers: { origin: ORIGIN, cookie: `asm_webauthn=${c.value}` },
    payload: { response: { id: 'cred-bob' } },
  });
}

const passwordLogin = (w: W, username: string) =>
  w.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password: PW } });

describe('admin: disable / enable users', () => {
  it('disable ends sessions, revokes devices (tokens, grants, open requests) and blocks password, passkey and bearer use', async () => {
    const w = await setup();
    const secret = createSecret(w.ctx, w.bob.actor, { title: 'Bob key', value: 'v' });
    const mcp = pairDevice(w.ctx, { userId: w.bob.id, kind: 'mcp', name: 'bob-mcp' });
    const cli = pairDevice(w.ctx, { userId: w.bob.id, kind: 'cli', name: 'bob-cli' });
    const pending = createRequest(w.ctx, { device: { id: mcp.deviceId, userId: w.bob.id, kind: 'mcp', name: 'bob-mcp' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' });
    expect((await bearer(w.app, mcp.accessToken)).statusCode).toBe(200);
    const otherBobSession = await login(w.app, 'bob');

    const res = await w.req(w.alice, 'POST', `/api/admin/users/${w.bob.id}/disable`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: w.bob.id, disabledAt: w.clock.now() });

    for (const cookie of [w.bob.cookie, otherBobSession]) {
      expect((await w.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    }
    expect(w.db.$client.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(w.bob.id)).toEqual({ n: 0 });
    expect((await bearer(w.app, mcp.accessToken)).statusCode).toBe(401);
    expect((await bearer(w.app, cli.accessToken)).statusCode).toBe(401);
    expect(w.db.$client.prepare("SELECT count(*) AS n FROM devices WHERE user_id = ? AND status <> 'revoked'").get(w.bob.id)).toEqual({ n: 0 });
    expect(w.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(pending.id)).toEqual({ status: 'denied' });
    const revoked = auditRows(w.db, 'device.revoked');
    expect(revoked).toHaveLength(2);
    for (const r of revoked) expect(r).toMatchObject({ actor_type: 'user', actor_id: w.alice.id });

    expect((await passwordLogin(w, 'bob')).statusCode).toBe(401);
    expect((await passkeyLogin(w)).statusCode).toBe(401);
    const refresh = await w.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: mcp.refreshToken } });
    expect(refresh.json().error).toBe('invalid_grant');

    const list = (await w.req(w.alice, 'GET', '/api/admin/users')).json().items as { id: string; disabledAt: number | null }[];
    expect(list.find((u) => u.id === w.bob.id)!.disabledAt).toBe(w.clock.now());
    expect(list.find((u) => u.id === w.alice.id)!.disabledAt).toBeNull();

    // Idempotent.
    expect((await w.req(w.alice, 'POST', `/api/admin/users/${w.bob.id}/disable`)).statusCode).toBe(200);

    const en = await w.req(w.alice, 'POST', `/api/admin/users/${w.bob.id}/enable`);
    expect(en.statusCode).toBe(200);
    expect(en.json()).toMatchObject({ id: w.bob.id, disabledAt: null });
    expect((await passwordLogin(w, 'bob')).statusCode).toBe(200);
    expect((await passkeyLogin(w)).statusCode).toBe(200);
    // Devices stay revoked after re-enabling.
    expect((await bearer(w.app, mcp.accessToken)).statusCode).toBe(401);
  });

  it('a disabled user is rejected by session and bearer checks even if sessions/devices still existed', async () => {
    const w = await setup();
    const mcp = pairDevice(w.ctx, { userId: w.bob.id, kind: 'mcp' });
    w.db.$client.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(w.bob.id);
    expect((await w.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: w.bob.cookie } })).statusCode).toBe(401);
    expect((await bearer(w.app, mcp.accessToken)).statusCode).toBe(401);
  });

  it('guards: admin only, recent auth, not self, unknown id 404', async () => {
    const w = await setup();
    expect((await w.req(w.bob, 'POST', `/api/admin/users/${w.alice.id}/disable`)).statusCode).toBe(403);
    expect((await w.req(undefined, 'POST', `/api/admin/users/${w.bob.id}/disable`)).statusCode).toBe(401);
    const self = await w.req(w.alice, 'POST', `/api/admin/users/${w.alice.id}/disable`);
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toBe('cannot_disable_self');
    expect((await w.req(w.alice, 'POST', '/api/admin/users/usr_nope/disable')).statusCode).toBe(404);
    expect((await w.req(w.alice, 'POST', '/api/admin/users/usr_nope/enable')).statusCode).toBe(404);
    w.clock.advance(MIN11);
    const stale = await w.req(w.alice, 'POST', `/api/admin/users/${w.bob.id}/disable`);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toBe('reauth_required');
    expect((await w.req(w.alice, 'POST', `/api/admin/users/${w.bob.id}/enable`)).statusCode).toBe(401);
  });

  it('the last active admin cannot be disabled (409 last_admin)', async () => {
    const w = await setup();
    let err: unknown;
    try {
      disableUser(w.ctx, w.bob.id, w.alice.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 409, code: 'last_admin' });
    expect(w.db.$client.prepare('SELECT disabled_at FROM users WHERE id = ?').get(w.alice.id)).toEqual({ disabled_at: null });
  });
});
