import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addBearerProbe, auditRows, bearer, login, world } from './helpers/fixtures.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

function startPairing(app: FastifyInstance, body: Record<string, string> = { client_name: 'asm CLI', hostname: 'work-laptop' }) {
  return app.inject({
    method: 'POST',
    url: '/oauth/device_authorization',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });
}

function poll(app: FastifyInstance, deviceCode: string) {
  return app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode }).toString(),
  });
}

async function setup() {
  const w = await world({ beforeReady: addBearerProbe });
  const res = await startPairing(w.app);
  expect(res.statusCode).toBe(200);
  const p = res.json() as { device_code: string; user_code: string };
  const activate = (userCode: string, decision: 'approve' | 'deny', user = w.alice) =>
    w.req(user, 'POST', '/api/devices/activate', { user_code: userCode, decision });
  return { ...w, p, activate };
}

describe('device authorization (RFC 8628)', () => {
  it('starts a pairing: response shape, pending cli device, audit', async () => {
    const s = await setup();
    expect(s.p).toEqual({
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
      verification_uri: 'https://asm.test/activate',
      expires_in: 600,
      interval: 5,
    });
    const dev = s.db.$client.prepare('SELECT * FROM devices').all() as Record<string, unknown>[];
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ kind: 'cli', status: 'pending', user_id: null, name: 'asm CLI', hostname: 'work-laptop' });
    const dc = s.db.$client.prepare('SELECT * FROM device_codes').get() as Record<string, unknown>;
    expect(dc.device_code_hash).toBe(sha256hex(s.p.device_code));
    expect(JSON.stringify(dc)).not.toContain(s.p.device_code);
    expect(auditRows(s.db, 'device.pair_requested')[0]).toMatchObject({ actor_type: 'system', device_id: dev[0]!.id });
  });

  it('accepts JSON and validates input', async () => {
    const w = await world();
    const j = await w.app.inject({ method: 'POST', url: '/oauth/device_authorization', payload: { client_name: 'asm CLI', hostname: 'h' } });
    expect(j.statusCode).toBe(200);
    const bad = await w.app.inject({ method: 'POST', url: '/oauth/device_authorization', payload: { client_name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_request');
  });

  it('rate limits device_authorization to 10/min per IP', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await startPairing(w.app)).statusCode).toBe(200);
    expect((await startPairing(w.app)).statusCode).toBe(429);
  });

  it('poll before approval -> authorization_pending; too fast -> slow_down (+5 s)', async () => {
    const s = await setup();
    const first = await poll(s.app, s.p.device_code);
    expect(first.statusCode).toBe(400);
    expect(first.json().error).toBe('authorization_pending');
    expect((await poll(s.app, s.p.device_code)).json().error).toBe('slow_down');
    // interval is now 10 s; polling after 5 s is still too fast and bumps it to 15 s
    s.clock.advance(5_000);
    expect((await poll(s.app, s.p.device_code)).json().error).toBe('slow_down');
    s.clock.advance(14_000);
    expect((await poll(s.app, s.p.device_code)).json().error).toBe('slow_down');
    s.clock.advance(20_000);
    expect((await poll(s.app, s.p.device_code)).json().error).toBe('authorization_pending');
  });

  it('after activation -> tokens exactly once; tokens work', async () => {
    const s = await setup();
    const act = await s.activate(s.p.user_code.toLowerCase().replace('-', ''), 'approve');
    expect(act.statusCode).toBe(200);
    const dev = s.db.$client.prepare('SELECT * FROM devices').get() as Record<string, unknown>;
    expect(dev).toMatchObject({ status: 'approved', user_id: s.alice.id });
    expect(auditRows(s.db, 'device.approved')[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: dev.id });

    const res = await poll(s.app, s.p.device_code);
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(t.access_token).toMatch(/^asm_at_/);
    expect(t.refresh_token).toMatch(/^asm_rt_/);
    const who = await bearer(s.app, t.access_token);
    expect(who.json()).toEqual({ id: dev.id, userId: s.alice.id, kind: 'cli', name: 'asm CLI' });

    s.clock.advance(5_000);
    const again = await poll(s.app, s.p.device_code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
    // the user_code is no longer usable either
    expect((await s.activate(s.p.user_code, 'approve')).statusCode).toBe(404);
  });

  it('after denial -> access_denied; device denied and audited', async () => {
    const s = await setup();
    expect((await s.activate(s.p.user_code, 'deny')).statusCode).toBe(200);
    const res = await poll(s.app, s.p.device_code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('access_denied');
    const dev = s.db.$client.prepare('SELECT id, status FROM devices').get() as { id: string; status: string };
    expect(dev.status).toBe('denied');
    expect(auditRows(s.db, 'device.denied')[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: dev.id });
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM tokens').get()).toEqual({ n: 0 });
  });

  it('after 10 minutes -> expired_token; activation no longer possible', async () => {
    const s = await setup();
    s.clock.advance(600_000);
    const res = await poll(s.app, s.p.device_code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('expired_token');
    // fresh login so recent-auth is not what rejects the activation
    const cookie = await login(s.app, 'alice');
    const act = await s.req({ ...s.alice, cookie }, 'POST', '/api/devices/activate', { user_code: s.p.user_code, decision: 'approve' });
    expect(act.statusCode).toBe(404);
    expect(act.json()).toEqual({ error: 'invalid_code' });
  });

  it('unknown device_code -> invalid_grant', async () => {
    const s = await setup();
    expect((await poll(s.app, 'nope')).json().error).toBe('invalid_grant');
  });
});

describe('POST /api/devices/activate', () => {
  it('unknown or malformed code -> 404 invalid_code', async () => {
    const s = await setup();
    for (const code of ['BCDF-GHJK', 'not a code', 'AAAA-AAAA']) {
      const r = await s.activate(code, 'approve');
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'invalid_code' });
    }
  });

  it('requires a session and recent auth', async () => {
    const s = await setup();
    expect((await s.req(undefined, 'POST', '/api/devices/activate', { user_code: s.p.user_code, decision: 'approve' })).statusCode).toBe(401);
    s.clock.advance(10 * 60_000 + 1);
    const stale = await s.activate(s.p.user_code, 'approve');
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    expect((s.db.$client.prepare('SELECT status FROM devices').get() as { status: string }).status).toBe('pending');
  });

  it('GET shows what is being paired; unknown code -> 404', async () => {
    const s = await setup();
    const r = await s.req(s.alice, 'GET', `/api/devices/activate?user_code=${s.p.user_code.toLowerCase()}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: 'asm CLI', hostname: 'work-laptop', requestedAt: s.clock.now(), linkCandidates: [], suggestedLinkId: null });
    expect((await s.req(s.alice, 'GET', '/api/devices/activate?user_code=BCDF-BCDF')).json()).toEqual({ error: 'invalid_code' });
    expect((await s.req(undefined, 'GET', `/api/devices/activate?user_code=${s.p.user_code}`)).statusCode).toBe(401);
  });

  it('device revoked between approval and poll -> invalid_grant, no tokens', async () => {
    const s = await setup();
    const act = await s.activate(s.p.user_code, 'approve');
    expect((await s.req(s.alice, 'POST', `/api/devices/${act.json().deviceId}/revoke`)).statusCode).toBe(200);
    expect((await poll(s.app, s.p.device_code)).json().error).toBe('invalid_grant');
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM tokens').get()).toEqual({ n: 0 });
  });

  it('a decided code cannot be decided again', async () => {
    const s = await setup();
    expect((await s.activate(s.p.user_code, 'deny')).statusCode).toBe(200);
    expect((await s.activate(s.p.user_code, 'approve', s.bob)).statusCode).toBe(404);
    expect((s.db.$client.prepare('SELECT status, user_id FROM devices').get() as Record<string, unknown>)).toEqual({ status: 'denied', user_id: null });
  });
});
