import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ApproveSummaryDtoSchema, newId, PushSubscriptionDtoSchema } from '@asm/shared';
import type { WebAuthnAdapter } from '../src/auth/webauthn.js';
import { FakeClock } from '../src/clock.js';
import { openDb } from '../src/db/client.js';
import { passkeys } from '../src/db/schema.js';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import { loadOrCreateVapidKeys } from '../src/push/vapid.js';
import type { PushSender } from '../src/push/service.js';
import { enableAutoMode } from '../src/requests/automode.js';
import { createRequest, createUpdateRequest, decideRequest } from '../src/requests/service.js';
import { archiveSecret, createSecret } from '../src/secrets/service.js';
import { FORBIDDEN_RESPONSE_KEYS, ORIGIN, allKeys, auditRows, pairDevice, world, type TestUser } from './helpers/fixtures.js';
import { TEST_KEY } from './helpers/testApp.js';

const MIN = 60_000;

function stubWebAuthn() {
  let counter = 0;
  return {
    generateRegistrationOptions: vi.fn(async () => ({ challenge: 'chal-reg' }) as never),
    verifyRegistration: vi.fn(async () => ({ verified: false as const })),
    generateAuthenticationOptions: vi.fn(async (o: Record<string, any>) => ({ challenge: `chal-${++counter}`, ...o }) as never),
    // Emulates the UV check of @simplewebauthn/server: a response flagged uv:false fails when UV is required.
    verifyAuthentication: vi.fn(async (o: Record<string, any>) => ({
      verified: !(o.requireUserVerification && o.response.uv === false),
      newCounter: ++counter,
    })),
  } satisfies WebAuthnAdapter;
}

type Sent = { endpoint: string; payload: Record<string, string>; opts: Record<string, any> };

function stubSender() {
  const sent: Sent[] = [];
  const failures = new Map<string, number>();
  const sender = vi.fn<PushSender>(async (target, payload, opts) => {
    const status = failures.get(target.endpoint);
    if (status) throw Object.assign(new Error('push failed'), { name: 'WebPushError', statusCode: status });
    sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, string>, opts });
  });
  return { sender, sent, failures };
}

const subBody = (endpoint: string, deviceName = 'iPhone') => ({
  subscription: { endpoint, expirationTime: null, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } },
  deviceName,
});

async function setup(opts: { config?: Record<string, unknown>; webDistDir?: string } = {}) {
  const webauthn = stubWebAuthn();
  const push = stubSender();
  const w = await world({ app: { webauthn, pushSender: push.sender, config: opts.config as never, webDistDir: opts.webDistDir } });
  const addPasskey = (user: TestUser, credentialId: string) =>
    w.db.insert(passkeys).values({ id: newId('pky'), userId: user.id, credentialId, publicKey: Buffer.from([1]), counter: 0, name: 'pk', createdAt: 0 }).run();
  addPasskey(w.alice, 'cred-alice');
  addPasskey(w.bob, 'cred-bob');
  const subscribe = (user: TestUser, endpoint: string, name?: string) => w.req(user, 'POST', '/api/push/subscriptions', subBody(endpoint, name));
  const secret = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Key', envName: 'STRIPE_KEY', value: 'sk_live_TOPSECRET' });
  const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'alice-laptop' });
  const device: DeviceIdentity = { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'alice-laptop' };
  const read = (delivery: 'cli' | 'plaintext' = 'cli') =>
    createRequest(w.ctx, { device, secretId: secret.id, project: 'Secret Project', reason: 'deploy prod', delivery });
  const tokensOf = (requestId: string) => push.sent.filter((s) => s.payload.tag === requestId).map((s) => s.payload.url!.slice('/approve/'.length));
  const api = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    w.app.inject({ method, url, headers: { ...(method === 'POST' ? { origin: ORIGIN } : {}), ...headers }, ...(payload ? { payload: payload as object } : {}) });
  const options = (token: string) => api('POST', `/api/approve/${token}/options`);
  const decide = (token: string, body: unknown) => api('POST', `/api/approve/${token}/decision`, body);
  const status = (requestId: string) => (w.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(requestId) as { status: string }).status;
  return { ...w, webauthn, push, subscribe, secret, device, read, tokensOf, api, options, decide, status };
}

describe('push subscriptions API', () => {
  it('requires a session', async () => {
    const t = await setup();
    for (const [method, url] of [['GET', '/api/push/vapid-key'], ['GET', '/api/push/subscriptions'], ['POST', '/api/push/subscriptions'], ['POST', '/api/push/test']] as const) {
      expect((await t.req(undefined, method, url, method === 'POST' ? {} : undefined)).statusCode, url).toBe(401);
    }
  });

  it('returns the VAPID public key (base64url, stable)', async () => {
    const t = await setup();
    const a = (await t.req(t.alice, 'GET', '/api/push/vapid-key')).json();
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await t.req(t.bob, 'GET', '/api/push/vapid-key')).json()).toEqual(a);
  });

  it('create, list, re-subscribe in place, delete — scoped per user', async () => {
    const t = await setup();
    const created = await t.subscribe(t.alice, 'https://web.push.apple.com/a1', 'iPhone');
    expect(created.statusCode).toBe(201);
    const dto = PushSubscriptionDtoSchema.parse(created.json());
    expect(dto).toMatchObject({ deviceName: 'iPhone', lastUsedAt: null });
    expect(dto.id).toMatch(/^psh_/);

    const again = await t.subscribe(t.alice, 'https://web.push.apple.com/a1', 'iPhone 15');
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ id: dto.id, deviceName: 'iPhone 15' });
    expect((await t.req(t.alice, 'GET', '/api/push/subscriptions')).json().items).toHaveLength(1);
    // Another user cannot take over an endpoint.
    expect((await t.subscribe(t.bob, 'https://web.push.apple.com/a1')).statusCode).toBe(409);
    expect((await t.req(t.bob, 'GET', '/api/push/subscriptions')).json()).toEqual({ items: [] });
    expect((await t.req(t.bob, 'DELETE', `/api/push/subscriptions/${dto.id}`)).statusCode).toBe(404);
    expect((await t.req(t.alice, 'DELETE', `/api/push/subscriptions/${dto.id}`)).statusCode).toBe(204);
    expect((await t.req(t.alice, 'GET', '/api/push/subscriptions')).json()).toEqual({ items: [] });
  });

  it('validates the subscription (https endpoint, keys, device name)', async () => {
    const t = await setup();
    const bad = [
      subBody('http://push.example/x'),
      { ...subBody('https://web.push.apple.com/x'), deviceName: '' },
      { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'x y', auth: 'a'.repeat(22) } }, deviceName: 'n' },
      { deviceName: 'n' },
    ];
    for (const body of bad) expect((await t.req(t.alice, 'POST', '/api/push/subscriptions', body)).statusCode).toBe(400);
  });

  it('POST /api/push/test sends the neutral test payload to own subscriptions only', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    await t.subscribe(t.alice, 'https://web.push.apple.com/a2');
    await t.subscribe(t.bob, 'https://web.push.apple.com/b1');
    const res = await t.req(t.alice, 'POST', '/api/push/test');
    expect(res.json()).toEqual({ sent: 2 });
    expect(t.push.sent.map((s) => s.endpoint).sort()).toEqual(['https://web.push.apple.com/a1', 'https://web.push.apple.com/a2']);
    for (const s of t.push.sent) {
      expect(s.payload).toEqual({ title: 'ASM', body: 'Test notification', url: '/settings', tag: 'asm-test' });
      expect(s.opts).toMatchObject({ TTL: 300, urgency: 'high', vapidDetails: { subject: 'mailto:asm@localhost' } });
    }
    expect((await t.req(t.alice, 'GET', '/api/push/subscriptions')).json().items[0].lastUsedAt).toBe(t.clock.now());
  });

  it('404/410 from the push service removes the subscription; other errors keep it; never throws', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/gone');
    await t.subscribe(t.alice, 'https://web.push.apple.com/notfound');
    await t.subscribe(t.alice, 'https://web.push.apple.com/flaky');
    t.push.failures.set('https://web.push.apple.com/gone', 410);
    t.push.failures.set('https://web.push.apple.com/notfound', 404);
    t.push.failures.set('https://web.push.apple.com/flaky', 500);
    expect((await t.req(t.alice, 'POST', '/api/push/test')).json()).toEqual({ sent: 0 });
    const items = (await t.req(t.alice, 'GET', '/api/push/subscriptions')).json().items as { id: string }[];
    expect(items).toHaveLength(1);
    // A failing push never breaks request creation.
    expect(t.read().status).toBe('pending');
  });
});

describe('VAPID keys', () => {
  it('are created once and stored with the private key sealed', () => {
    const db = openDb(':memory:');
    const clock = new FakeClock();
    const a = loadOrCreateVapidKeys(db, clock, TEST_KEY);
    const b = loadOrCreateVapidKeys(db, clock, TEST_KEY);
    expect(b).toEqual(a);
    const row = db.$client.prepare('SELECT * FROM vapid_keys').all() as Record<string, unknown>[];
    expect(row).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain(a.privateKey);
    expect(() => loadOrCreateVapidKeys(db, clock, Buffer.alloc(32, 9))).toThrow();
  });
});

describe('approval tokens', () => {
  it('pending request → one token per subscription of the device owner, neutral payload, hashed at rest', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    await t.subscribe(t.alice, 'https://web.push.apple.com/a2');
    await t.subscribe(t.bob, 'https://web.push.apple.com/b1');
    const r = t.read();
    await vi.waitFor(() => expect(t.push.sent).toHaveLength(2));
    expect(t.push.sent.map((s) => s.endpoint).sort()).toEqual(['https://web.push.apple.com/a1', 'https://web.push.apple.com/a2']);
    const tokens = t.tokensOf(r.id);
    expect(new Set(tokens).size).toBe(2);
    for (const s of t.push.sent) {
      expect(Object.keys(s.payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
      expect(s.payload).toMatchObject({ title: 'ASM', body: 'New request waiting for approval', tag: r.id });
      expect(s.payload.url).toMatch(/^\/approve\/[A-Za-z0-9_-]{43}$/);
      const text = JSON.stringify(s.payload);
      for (const leak of ['Stripe', 'STRIPE_KEY', 'secret-project', 'Secret Project', 'deploy', 'alice-laptop', 'sk_live']) expect(text).not.toContain(leak);
    }
    const rows = t.db.$client.prepare('SELECT * FROM approve_tokens').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    const hashes = tokens.map((tok) => createHash('sha256').update(tok).digest('hex')).sort();
    expect(rows.map((x) => x.token_hash).sort()).toEqual(hashes);
    expect(JSON.stringify(rows)).not.toContain(tokens[0]);
    for (const row of rows) expect(row).toMatchObject({ request_id: r.id, user_id: t.alice.id, expires_at: r.expiresAt, used_at: null });
  });

  it('no token and no push for auto-approved requests or users without subscriptions', async () => {
    const t = await setup();
    t.read();
    await t.subscribe(t.bob, 'https://web.push.apple.com/b1');
    expect(t.read().status).toBe('pending'); // alice has no subscription
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    enableAutoMode(t.ctx, t.alice.id, 30);
    expect(t.read().status).toBe('approved');
    await new Promise((r) => setTimeout(r, 10));
    expect(t.push.sender).not.toHaveBeenCalled();
    expect(t.db.$client.prepare('SELECT count(*) AS n FROM approve_tokens').get()).toEqual({ n: 0 });
  });

  it('GET summary: request details without values, no-store; invalid tokens are a uniform 404', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    const r = t.read();
    const [token] = t.tokensOf(r.id);
    const res = await t.api('GET', `/api/approve/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ApproveSummaryDtoSchema.parse(res.json())).toEqual({
      kind: 'read', device: { name: 'alice-laptop' }, secret: { title: 'Stripe Key', envName: 'STRIPE_KEY' }, project: 'secret-project',
      reason: 'deploy prod', delivery: 'cli', expiresAt: r.expiresAt, status: 'pending',
    });
    for (const k of FORBIDDEN_RESPONSE_KEYS) expect(allKeys(res.json()).has(k)).toBe(false);
    for (const bad of ['nope', 'A'.repeat(43), 'x'.repeat(100)]) {
      const nf = await t.api('GET', `/api/approve/${bad}`);
      expect(nf.statusCode).toBe(404);
      expect(nf.json()).toEqual({ error: 'not_found' });
      expect(nf.headers['cache-control']).toBe('no-store');
    }
  });

  it('expires with the request', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    const [token] = t.tokensOf(t.read().id);
    t.clock.advance(5 * MIN);
    expect((await t.api('GET', `/api/approve/${token}`)).statusCode).toBe(404);
    expect((await t.decide(token!, { decision: 'deny' })).statusCode).toBe(404);
  });

  it('deny without assertion; single use; sibling links die; audited with via push', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    await t.subscribe(t.alice, 'https://web.push.apple.com/a2');
    const r = t.read();
    const [tok1, tok2] = t.tokensOf(r.id);
    const res = await t.decide(tok1!, { decision: 'deny' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ status: 'denied', kind: 'read' });
    expect(t.status(r.id)).toBe('denied');
    expect(t.webauthn.verifyAuthentication).not.toHaveBeenCalled();
    const audit = auditRows(t.db, 'request.denied')[0]!;
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: t.alice.id });
    expect(JSON.parse(audit.meta as string)).toMatchObject({ via: 'push', requestId: r.id });
    for (const tok of [tok1!, tok2!]) {
      expect((await t.api('GET', `/api/approve/${tok}`)).statusCode).toBe(404);
      expect((await t.decide(tok, { decision: 'approve' })).statusCode).toBe(404);
    }
    expect(t.db.$client.prepare('SELECT count(*) AS n FROM approve_tokens WHERE used_at IS NULL').get()).toEqual({ n: 0 });
  });

  it('dashboard decision makes the links useless (and marks them used)', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    const r = t.read();
    const [token] = t.tokensOf(r.id);
    decideRequest(t.ctx, { requestId: r.id, userId: t.alice.id, decision: 'approve' });
    expect((await t.api('GET', `/api/approve/${token}`)).statusCode).toBe(404);
    expect((await t.decide(token!, { decision: 'deny' })).statusCode).toBe(404);
    expect(t.db.$client.prepare('SELECT used_at FROM approve_tokens').get()).toEqual({ used_at: t.clock.now() });
  });
});

describe('approve via push link', () => {
  async function pending() {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    const r = t.read();
    const [token] = t.tokensOf(r.id);
    return { ...t, r, token: token! };
  }

  it('options: only the owner passkeys, UV required, no-store', async () => {
    const t = await pending();
    const res = await t.options(t.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const arg = t.webauthn.generateAuthenticationOptions.mock.calls[0]![0];
    expect(arg).toMatchObject({ rpID: 'asm.test', userVerification: 'required', allowCredentials: [{ id: 'cred-alice' }] });
    expect(res.json().challenge).toBeTruthy();
    expect((await t.options('invalid')).statusCode).toBe(404);
  });

  it('approve with a UV assertion of the owner passkey → approved, grant issued, audited via push', async () => {
    const t = await pending();
    const o = (await t.options(t.token)).json();
    const res = await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved' });
    expect(t.webauthn.verifyAuthentication.mock.calls[0]![0]).toMatchObject({
      expectedChallenge: o.challenge, expectedOrigin: ORIGIN, expectedRPID: 'asm.test', requireUserVerification: true, credential: { id: 'cred-alice' },
    });
    expect(t.status(t.r.id)).toBe('approved');
    expect(t.db.$client.prepare('SELECT count(*) AS n FROM grants WHERE request_id = ?').get(t.r.id)).toEqual({ n: 1 });
    const audit = auditRows(t.db, 'request.approved')[0]!;
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: t.alice.id });
    expect(JSON.parse(audit.meta as string)).toMatchObject({ via: 'push' });
    expect((await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice' } })).statusCode).toBe(404);
  });

  it('rejects: no response, no challenge, another user\'s passkey, missing UV (401) — link stays usable', async () => {
    const t = await pending();
    expect((await t.decide(t.token, { decision: 'approve' })).json()).toEqual({ error: 'verification_failed' });
    expect((await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice' } })).statusCode).toBe(401); // no options yet
    await t.options(t.token);
    const wrongUser = await t.decide(t.token, { decision: 'approve', response: { id: 'cred-bob' } });
    expect(wrongUser.statusCode).toBe(401);
    await t.options(t.token);
    expect((await t.decide(t.token, { decision: 'approve', response: { id: 'cred-unknown' } })).statusCode).toBe(401);
    await t.options(t.token);
    const noUv = await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice', uv: false } });
    expect(noUv.statusCode).toBe(401);
    expect(noUv.json()).toEqual({ error: 'verification_failed' });
    // Challenge is single use: a verified retry without new options fails.
    expect((await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice' } })).statusCode).toBe(401);
    expect(t.status(t.r.id)).toBe('pending');
    expect((await t.decide(t.token, { decision: 'deny' })).json()).toMatchObject({ status: 'denied' });
  });

  it('disabled owner: link is dead', async () => {
    const t = await pending();
    t.db.$client.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(t.alice.id);
    expect((await t.api('GET', `/api/approve/${t.token}`)).statusCode).toBe(404);
    expect((await t.decide(t.token, { decision: 'deny' })).statusCode).toBe(404);
  });

  it('plaintext flag gone → 403 plaintext_not_allowed', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    t.db.$client.prepare('UPDATE secrets SET allow_plaintext_to_agent = 1').run();
    const r = t.read('plaintext');
    const [token] = t.tokensOf(r.id);
    // Raw change without the hook: the decision itself re-checks the flag.
    t.db.$client.prepare('UPDATE secrets SET allow_plaintext_to_agent = 0').run();
    await t.options(token!);
    const res = await t.decide(token!, { decision: 'approve', response: { id: 'cred-alice' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'plaintext_not_allowed' });
    expect(t.status(r.id)).toBe('denied');
  });

  it('device inactive → 409 device_inactive; archived secret → 404', async () => {
    const t = await pending();
    t.db.$client.prepare(`UPDATE devices SET status = 'revoked'`).run();
    await t.options(t.token);
    const res = await t.decide(t.token, { decision: 'approve', response: { id: 'cred-alice' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'device_inactive' });

    const t2 = await pending();
    archiveSecret(t2.ctx, t2.alice.actor, t2.secret.id, { reason: 'old' });
    expect((await t2.api('GET', `/api/approve/${t2.token}`)).statusCode).toBe(404);
  });

  it('rate limits the public API to 30 requests per minute and IP', async () => {
    const t = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await t.api('GET', `/api/approve/tok${i}`)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes[30]).toBe(429);
    expect((await t.api('POST', '/api/approve/x/decision', { decision: 'deny' })).statusCode).toBe(429);
    expect((await t.api('GET', '/api/approve/x', undefined, { 'x-forwarded-for': '1.2.3.4' })).statusCode).toBe(429); // no trustProxy
  });

  it('rejects foreign Origin on POST', async () => {
    const t = await pending();
    const res = await t.app.inject({ method: 'POST', url: `/api/approve/${t.token}/decision`, headers: { origin: 'https://evil.test' }, payload: { decision: 'deny' } });
    expect(res.statusCode).toBe(403);
    expect(t.status(t.r.id)).toBe('pending');
  });
});

describe('ASM_TRUSTED_NETWORKS gate', () => {
  function makeDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'asm-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    writeFileSync(join(dir, 'sw.js'), '// sw');
    writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
    mkdirSync(join(dir, 'icons'));
    for (const n of [180, 192, 512]) writeFileSync(join(dir, 'icons', `icon-${n}.png`), 'png');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc.js'), 'x');
    return dir;
  }

  async function gated(opts: { trustProxy?: number | string } = {}) {
    const t = await setup({
      config: { trustProxy: opts.trustProxy ?? 1, trustedNetworks: [
        { address: '127.0.0.0', prefix: 8, family: 'ipv4' }, // inject() default, so fixtures can log in
        { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
        { address: 'fd00::', prefix: 8, family: 'ipv6' },
      ] },
      webDistDir: makeDist(),
    });
    const from = (ip: string, url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, cookie?: string) =>
      t.app.inject({
        method, url, headers: { 'x-forwarded-for': ip, ...(method === 'POST' ? { origin: ORIGIN } : {}), ...(cookie ? { cookie } : {}) },
        ...(payload ? { payload: payload as object } : {}),
      });
    return { ...t, from };
  }

  const OUTSIDE = '203.0.113.7';

  it('trusted clients (incl. IPv4-mapped IPv6) reach everything', async () => {
    const t = await gated();
    for (const ip of ['192.168.1.10', '::ffff:192.168.1.10', 'fd12::1']) {
      const res = await t.from(ip, '/api/push/subscriptions', 'GET', undefined, t.alice.cookie);
      expect(res.statusCode, ip).toBe(200);
      expect((await t.from(ip, '/login')).statusCode, ip).toBe(200);
    }
  });

  it('untrusted clients only reach the public paths', async () => {
    const t = await gated();
    expect((await t.from(OUTSIDE, '/api/push/subscriptions', 'POST', subBody('https://web.push.apple.com/a1'), t.alice.cookie)).statusCode).toBe(404);
    expect((await t.from('192.168.1.10', '/api/push/subscriptions', 'POST', subBody('https://web.push.apple.com/a1'), t.alice.cookie)).statusCode).toBe(201);
    const r = t.read();
    const [token] = t.tokensOf(r.id);

    const blocked = await t.from(OUTSIDE, '/api/secrets', 'GET', undefined, t.alice.cookie);
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json()).toEqual({ error: 'not_found' });
    for (const url of ['/api/setup/status', '/api/auth/me', '/mcp', '/oauth/token', '/.well-known/oauth-authorization-server', '/cli/install.sh', '/api/approve/x/../../secrets']) {
      expect((await t.from(OUTSIDE, url)).statusCode, url).toBe(404);
    }
    const page = await t.from(OUTSIDE, '/login');
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain('root');
    expect((await t.from(OUTSIDE, '/approve/abc/../../login')).statusCode).toBe(404);

    // Public paths
    const approvePage = await t.from(OUTSIDE, `/approve/${token}`);
    expect(approvePage.statusCode).toBe(200);
    expect(approvePage.body).toContain('<div id="root">');
    expect((await t.from(OUTSIDE, '/assets/index-abc.js')).statusCode).toBe(200);
    expect((await t.from(OUTSIDE, '/favicon.svg')).statusCode).toBe(200);
    expect((await t.from(OUTSIDE, '/healthz')).statusCode).toBe(200);
    for (const url of ['/sw.js', '/manifest.webmanifest', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png']) {
      expect((await t.from(OUTSIDE, url)).statusCode, url).toBe(200);
    }
    expect((await t.from(OUTSIDE, '/icons/other.png')).statusCode).toBe(404);
    expect((await t.from(OUTSIDE, `/api/approve/${token}`)).json()).toMatchObject({ status: 'pending' });
    expect((await t.from(OUTSIDE, `/api/approve/${token}/options`, 'POST')).statusCode).toBe(200);
    expect((await t.from(OUTSIDE, `/api/approve/${token}/decision`, 'POST', { decision: 'deny' })).json()).toMatchObject({ status: 'denied' });
  });

  for (const trustProxy of [1, '127.0.0.1/32']) {
    it(`a spoofed X-Forwarded-For entry does not make a client trusted (trustProxy ${trustProxy})`, async () => {
      const t = await gated({ trustProxy });
      const spoofed = await t.from(`192.168.1.10, ${OUTSIDE}`, '/api/push/subscriptions', 'GET', undefined, t.alice.cookie);
      expect(spoofed.statusCode).toBe(404);
      expect((await t.from(`${OUTSIDE}, 192.168.1.10`, '/api/push/subscriptions', 'GET', undefined, t.alice.cookie)).statusCode).toBe(200);
    });
  }

  it('the approval rate limit is keyed on the real client IP, not on spoofable entries', async () => {
    const t = await gated();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await t.from(`10.0.0.${i}, ${OUTSIDE}`, `/api/approve/tok${i}`)).statusCode);
    expect(codes[29]).toBe(404);
    expect(codes[30]).toBe(429);
    expect((await t.from('198.51.100.1', '/api/approve/other')).statusCode).toBe(404);
  });
});

describe('push endpoint allowlist', () => {
  it('only known push services are accepted; sends use a timeout', async () => {
    const t = await setup();
    for (const ep of ['https://evil.example/x', 'https://web.push.apple.com:8443/x', 'https://user@fcm.googleapis.com/x', 'https://push.apple.com.evil.example/x', 'https://127.0.0.1/x']) {
      const res = await t.subscribe(t.alice, ep);
      expect(res.statusCode, ep).toBe(400);
      expect(res.json(), ep).toEqual({ error: 'unsupported_push_service' });
    }
    for (const ep of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect((await t.subscribe(t.alice, ep)).statusCode, ep).toBe(201);
    }
    // Rows that bypassed validation are never contacted.
    t.db.$client.prepare(`UPDATE push_subscriptions SET endpoint = 'https://internal.example/x' WHERE endpoint LIKE 'https://fcm%'`).run();
    expect((await t.req(t.alice, 'POST', '/api/push/test')).json()).toEqual({ sent: 3 });
    expect(t.push.sent.every((s) => s.opts.timeout === 10_000)).toBe(true);
    expect(t.push.sent.some((s) => s.endpoint.includes('internal'))).toBe(false);
  });

  it('no push for disabled owners', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    t.db.$client.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?').run(t.alice.id);
    t.read();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.push.sender).not.toHaveBeenCalled();
    expect(t.db.$client.prepare('SELECT count(*) AS n FROM approve_tokens').get()).toEqual({ n: 0 });
  });
});

describe('approval summary of update requests', () => {
  it('shows title/envName changes, redacts description and tags', async () => {
    const t = await setup();
    await t.subscribe(t.alice, 'https://web.push.apple.com/a1');
    const r = createUpdateRequest(t.ctx, {
      device: t.device, secretId: t.secret.id, project: 'p', reason: 'rotate',
      meta: { title: 'Stripe Live', description: 'internal notes', tags: ['prod'] }, value: 'new-secret-value',
    });
    const [token] = t.tokensOf(r.id);
    const body = (await t.api('GET', `/api/approve/${token}`)).json();
    ApproveSummaryDtoSchema.parse(body);
    expect(body).toMatchObject({ kind: 'update', valueChanged: true, delivery: null });
    expect(body.metaDiff).toEqual({
      title: { from: 'Stripe Key', to: 'Stripe Live' },
      description: { from: null, to: null, redacted: true },
      tags: { from: null, to: null, redacted: true },
    });
    expect(JSON.stringify(body)).not.toMatch(/internal notes|prod"|new-secret-value/);
  });
});

describe('approval tokens are never logged', () => {
  it('request logs redact /approve/<token> and /api/approve/<token>', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (l: string) => void lines.push(l) });
    const webauthn = stubWebAuthn();
    const push = stubSender();
    const w = await world({ app: { webauthn, pushSender: push.sender, logger } });
    await w.req(w.alice, 'POST', '/api/push/subscriptions', subBody('https://web.push.apple.com/a1'));
    const secret = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp' });
    const r = createRequest(w.ctx, { device: { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'd' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' });
    const token = push.sent.find((s) => s.payload.tag === r.id)!.payload.url!.slice('/approve/'.length);
    await w.app.inject({ method: 'GET', url: `/api/approve/${token}` });
    await w.app.inject({ method: 'POST', url: `/api/approve/${token}/options?x=1`, headers: { origin: ORIGIN } });
    await w.app.inject({ method: 'GET', url: `/approve/${token}` });
    const out = lines.join('');
    expect(out).toContain('/api/approve/[REDACTED]/options?x=1');
    expect(out).toContain('"/approve/[REDACTED]"');
    expect(out).not.toContain(token);
  });
});
