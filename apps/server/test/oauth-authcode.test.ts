import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { verifyChain } from '../src/audit/audit.js';
import { addBearerProbe, auditRows, bearer, world } from './helpers/fixtures.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const REDIRECT = 'http://127.0.0.1:33418/callback';
const RESOURCE = 'https://asm.test/mcp';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

function tokenReq(app: FastifyInstance, params: Record<string, string>, asJson = false) {
  return app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded' },
    payload: asJson ? JSON.stringify(params) : form(params),
  });
}

async function register(app: FastifyInstance, body: Record<string, unknown> = { redirect_uris: [REDIRECT], client_name: 'Claude Code' }) {
  return app.inject({ method: 'POST', url: '/oauth/register', payload: body });
}

function authorizeUrl(q: Record<string, string>) {
  return `/oauth/authorize?${new URLSearchParams(q).toString()}`;
}

async function setup() {
  const w = await world({ beforeReady: addBearerProbe });
  const reg = await register(w.app);
  const clientId = reg.json().client_id as string;
  const p = pkce();
  const baseQuery = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: RESOURCE,
  };
  const startAuthorize = async (q: Record<string, string> = baseQuery) => {
    const res = await w.app.inject({ method: 'GET', url: authorizeUrl(q) });
    return res;
  };
  const reqIdOf = (location: string) => new URL(location, 'https://asm.test').searchParams.get('req')!;
  const approve = async (deviceName?: string) => {
    const res = await startAuthorize();
    const reqId = reqIdOf(res.headers.location as string);
    const c = await w.req(w.alice, 'POST', '/api/oauth/consent', { req: reqId, decision: 'approve', ...(deviceName ? { deviceName } : {}) });
    expect(c.statusCode).toBe(200);
    const redirectTo = new URL(c.json().redirectTo as string);
    return { code: redirectTo.searchParams.get('code')!, redirectTo };
  };
  const exchange = (code: string, verifier = p.verifier, extra: Record<string, string> = {}) =>
    tokenReq(w.app, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId, ...extra });
  return { ...w, clientId, p, baseQuery, startAuthorize, reqIdOf, approve, exchange };
}

describe('oauth metadata', () => {
  it('serves authorization-server and protected-resource metadata', async () => {
    const w = await world();
    const as = await w.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(as.statusCode).toBe(200);
    expect(as.json()).toEqual({
      issuer: 'https://asm.test',
      authorization_endpoint: 'https://asm.test/oauth/authorize',
      token_endpoint: 'https://asm.test/oauth/token',
      registration_endpoint: 'https://asm.test/oauth/register',
      device_authorization_endpoint: 'https://asm.test/oauth/device_authorization',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [],
    });
    const expected = { resource: RESOURCE, authorization_servers: ['https://asm.test'], bearer_methods_supported: ['header'] };
    expect((await w.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json()).toEqual(expected);
    expect((await w.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json()).toEqual(expected);
  });
});

describe('dynamic client registration', () => {
  it('registers public clients with loopback or https redirect URIs', async () => {
    const w = await world();
    const res = await register(w.app, { redirect_uris: [REDIRECT, 'http://localhost/cb', 'https://app.example/cb'], client_name: 'Claude Code', token_endpoint_auth_method: 'none' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.client_id).toMatch(/^cli_[0-9A-Z]{26}$/);
    expect(body).toMatchObject({
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT, 'http://localhost/cb', 'https://app.example/cb'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(body.client_secret).toBeUndefined();
    const def = await register(w.app, { redirect_uris: [REDIRECT] });
    expect(def.json().client_name).toBe('MCP Client');
  });

  it('rejects non-loopback http, missing redirect_uris, confidential clients', async () => {
    const w = await world();
    for (const body of [
      { redirect_uris: ['http://evil.example/cb'] },
      { redirect_uris: ['javascript:alert(1)'] },
      { redirect_uris: ['https://app.example/cb#frag'] },
      { redirect_uris: [] },
      {},
    ]) {
      const r = await register(w.app, body);
      expect(r.statusCode).toBe(400);
      expect(['invalid_redirect_uri', 'invalid_client_metadata']).toContain(r.json().error);
    }
    const conf = await register(w.app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
    expect(conf.statusCode).toBe(400);
    expect(conf.json().error).toBe('invalid_client_metadata');
    expect((await register(w.app, { redirect_uris: [REDIRECT], client_name: 'x'.repeat(101) })).statusCode).toBe(400);
  });

  it('rate limits registration to 10/min per IP', async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) expect((await register(w.app)).statusCode).toBe(201);
    expect((await register(w.app)).statusCode).toBe(429);
  });
});

describe('authorize endpoint', () => {
  it('valid request redirects to the consent page; loopback port may differ', async () => {
    const s = await setup();
    const res = await s.startAuthorize({ ...s.baseQuery, redirect_uri: 'http://127.0.0.1:51234/callback' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/connect\?req=[A-Za-z0-9_-]{43}$/);
    const details = await s.req(s.alice, 'GET', `/api/oauth/consent/${s.reqIdOf(res.headers.location as string)}`);
    expect(details.statusCode).toBe(200);
    expect(details.json()).toEqual({ clientName: 'Claude Code', redirectHost: '127.0.0.1:51234', requestedAt: s.clock.now() });
    expect((await s.req(undefined, 'GET', `/api/oauth/consent/${s.reqIdOf(res.headers.location as string)}`)).statusCode).toBe(401);
    expect((await s.req(s.alice, 'GET', '/api/oauth/consent/nope')).statusCode).toBe(404);
  });

  it('unknown client or unregistered redirect_uri -> 400 JSON, never a redirect', async () => {
    const s = await setup();
    for (const q of [
      { ...s.baseQuery, client_id: 'cli_unknown' },
      { ...s.baseQuery, redirect_uri: 'http://127.0.0.1:33418/other' },
      { ...s.baseQuery, redirect_uri: 'https://evil.example/callback' },
      { ...s.baseQuery, redirect_uri: 'http://localhost:33418/callback' },
    ]) {
      const res = await s.startAuthorize(q);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
      expect(['invalid_client', 'invalid_redirect_uri']).toContain(res.json().error);
    }
  });

  it('other errors redirect to the client with error and state', async () => {
    const s = await setup();
    const { code_challenge: _c, ...noChallenge } = s.baseQuery;
    const cases: [Record<string, string>, string][] = [
      [{ ...s.baseQuery, response_type: 'token' }, 'unsupported_response_type'],
      [noChallenge, 'invalid_request'],
      [{ ...s.baseQuery, code_challenge_method: 'plain' }, 'invalid_request'],
      [{ ...s.baseQuery, resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [q, err] of cases) {
      const res = await s.startAuthorize(q);
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(`${loc.origin}${loc.pathname}`).toBe('http://127.0.0.1:33418/callback');
      expect(loc.searchParams.get('error')).toBe(err);
      expect(loc.searchParams.get('state')).toBe('st-123');
    }
  });

  it('pending authorization expires after 10 minutes', async () => {
    const s = await setup();
    const reqId = s.reqIdOf((await s.startAuthorize()).headers.location as string);
    s.clock.advance(10 * 60_000 + 1);
    expect((await s.req(s.alice, 'GET', `/api/oauth/consent/${reqId}`)).statusCode).toBe(404);
  });
});

describe('consent', () => {
  it('approve creates an mcp device, audits, returns redirect with code and state', async () => {
    const s = await setup();
    const { code, redirectTo } = await s.approve('Laptop Claude');
    expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(REDIRECT);
    expect(redirectTo.searchParams.get('state')).toBe('st-123');
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dev = s.db.$client.prepare('SELECT * FROM devices').all() as Record<string, unknown>[];
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ kind: 'mcp', status: 'approved', user_id: s.alice.id, name: 'Laptop Claude' });
    expect(auditRows(s.db, 'device.approved')[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: dev[0]!.id });
    const codeRow = s.db.$client.prepare('SELECT * FROM oauth_codes').get() as Record<string, unknown>;
    expect(codeRow.code_hash).toBe(sha256hex(code));
  });

  it('default device name is the client name; name validated', async () => {
    const s = await setup();
    await s.approve();
    expect((s.db.$client.prepare('SELECT name FROM devices').get() as { name: string }).name).toBe('Claude Code');
    const reqId = s.reqIdOf((await s.startAuthorize()).headers.location as string);
    expect((await s.req(s.alice, 'POST', '/api/oauth/consent', { req: reqId, decision: 'approve', deviceName: 'x'.repeat(101) })).statusCode).toBe(400);
  });

  it('deny audits and redirects with access_denied; request is consumed', async () => {
    const s = await setup();
    const reqId = s.reqIdOf((await s.startAuthorize()).headers.location as string);
    const res = await s.req(s.alice, 'POST', '/api/oauth/consent', { req: reqId, decision: 'deny' });
    expect(res.statusCode).toBe(200);
    const loc = new URL(res.json().redirectTo as string);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('code')).toBeNull();
    expect(auditRows(s.db, 'device.denied')[0]).toMatchObject({ actor_id: s.alice.id, meta: JSON.stringify({ clientName: 'Claude Code' }) });
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM devices').get()).toEqual({ n: 0 });
    expect((await s.req(s.alice, 'POST', '/api/oauth/consent', { req: reqId, decision: 'approve' })).statusCode).toBe(404);
  });

  it('requires a session, the Origin header and recent auth', async () => {
    const s = await setup();
    const reqId = s.reqIdOf((await s.startAuthorize()).headers.location as string);
    expect((await s.req(undefined, 'POST', '/api/oauth/consent', { req: reqId, decision: 'approve' })).statusCode).toBe(401);
    const noOrigin = await s.app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { cookie: s.alice.cookie }, payload: { req: reqId, decision: 'approve' } });
    expect(noOrigin.statusCode).toBe(403);
    s.clock.advance(9 * 60_000); // pending still valid, but last auth is old after the next advance
    s.clock.advance(2 * 60_000);
    const stale = await s.req(s.alice, 'POST', '/api/oauth/consent', { req: reqId, decision: 'approve' });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
  });
});

describe('token endpoint: authorization_code', () => {
  it('full PKCE flow issues tokens that work with bearerAuth', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const res = await s.exchange(code);
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t).toEqual({ access_token: expect.stringMatching(/^asm_at_[A-Za-z0-9_-]{43}$/), token_type: 'Bearer', expires_in: 3600, refresh_token: expect.stringMatching(/^asm_rt_[A-Za-z0-9_-]{43}$/) });
    expect(res.headers['cache-control']).toBe('no-store');
    const who = await bearer(s.app, t.access_token);
    expect(who.statusCode).toBe(200);
    const dev = s.db.$client.prepare('SELECT * FROM devices').get() as Record<string, unknown>;
    expect(who.json()).toEqual({ id: dev.id, userId: s.alice.id, kind: 'mcp', name: 'Claude Code' });
    expect(dev.last_used_at).toBe(s.clock.now());
    expect(verifyChain(s.db)).toEqual({ ok: true });
  });

  it('accepts JSON bodies too', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const res = await tokenReq(s.app, { grant_type: 'authorization_code', code, code_verifier: s.p.verifier, redirect_uri: REDIRECT, client_id: s.clientId }, true);
    expect(res.statusCode).toBe(200);
  });

  it('wrong code_verifier -> invalid_grant (and the code is burned)', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const bad = await s.exchange(code, pkce().verifier);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_grant');
    expect((await s.exchange(code)).json().error).toBe('invalid_grant');
  });

  it('code used twice -> invalid_grant', async () => {
    const s = await setup();
    const { code } = await s.approve();
    expect((await s.exchange(code)).statusCode).toBe(200);
    const again = await s.exchange(code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
  });

  it('code expires after 60 s; redirect_uri and client_id must match', async () => {
    const s = await setup();
    const a = await s.approve();
    s.clock.advance(61_000);
    expect((await s.exchange(a.code)).json().error).toBe('invalid_grant');
    const b = await s.approve();
    expect((await s.exchange(b.code, s.p.verifier, { redirect_uri: 'http://127.0.0.1:1/callback' })).json().error).toBe('invalid_grant');
    const other = (await register(s.app)).json().client_id as string;
    const c = await s.approve();
    expect((await s.exchange(c.code, s.p.verifier, { client_id: other })).json().error).toBe('invalid_grant');
    const d = await s.approve();
    const unknown = await s.exchange(d.code, s.p.verifier, { client_id: 'cli_nope' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('invalid_client');
  });

  it('rejects unsupported grant types and malformed requests per RFC 6749', async () => {
    const s = await setup();
    const r1 = await tokenReq(s.app, { grant_type: 'password', username: 'a', password: 'b' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe('unsupported_grant_type');
    const r2 = await tokenReq(s.app, { grant_type: 'authorization_code' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe('invalid_request');
  });

  it('stores tokens and codes only as sha256', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const t = (await s.exchange(code)).json();
    const rows = s.db.$client.prepare('SELECT * FROM tokens').all() as { kind: string; token_hash: string }[];
    expect(rows.map((r) => [r.kind, r.token_hash]).sort()).toEqual([['access', sha256hex(t.access_token)], ['refresh', sha256hex(t.refresh_token)]].sort());
    const dump = JSON.stringify([
      ...s.db.$client.prepare('SELECT * FROM tokens').all(),
      ...s.db.$client.prepare('SELECT * FROM oauth_codes').all(),
      ...s.db.$client.prepare('SELECT * FROM audit_log').all(),
    ]);
    for (const raw of [code, t.access_token, t.refresh_token, t.access_token.slice(7), t.refresh_token.slice(7)]) expect(dump).not.toContain(raw);
  });

  it('access token expires after 1 h (61 min -> 401 with WWW-Authenticate)', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const t = (await s.exchange(code)).json();
    s.clock.advance(59 * 60_000);
    expect((await bearer(s.app, t.access_token)).statusCode).toBe(200);
    s.clock.advance(2 * 60_000);
    const res = await bearer(s.app, t.access_token);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://asm.test/.well-known/oauth-protected-resource", error="invalid_token"',
    );
  });

  it('missing or garbage bearer token -> 401 with resource_metadata', async () => {
    const s = await setup();
    const none = await bearer(s.app, undefined);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer resource_metadata="https://asm.test/.well-known/oauth-protected-resource"');
    const junk = await bearer(s.app, 'asm_at_garbage');
    expect(junk.statusCode).toBe(401);
    expect(junk.headers['www-authenticate']).toContain('error="invalid_token"');
    // A refresh token is not an access token.
    const { code } = await s.approve();
    const t = (await s.exchange(code)).json();
    expect((await bearer(s.app, t.refresh_token)).statusCode).toBe(401);
    // A session cookie is not a bearer token.
    expect((await s.app.inject({ method: 'GET', url: '/test/whoami', headers: { cookie: s.alice.cookie } })).statusCode).toBe(401);
  });

  it('rate limits the token endpoint to 20/min per IP', async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++) expect((await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: 'asm_rt_x' })).statusCode).toBe(400);
    expect((await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: 'asm_rt_x' })).statusCode).toBe(429);
  });
});

describe('token endpoint: refresh_token', () => {
  it('rotates refresh tokens; reuse of an old refresh token revokes the device', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const t1 = (await s.exchange(code)).json();
    const r = await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: s.clientId });
    expect(r.statusCode).toBe(200);
    const t2 = r.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await bearer(s.app, t2.access_token)).statusCode).toBe(200);

    const reuse = await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: t1.refresh_token });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe('invalid_grant');
    const dev = s.db.$client.prepare('SELECT id, status FROM devices').get() as { id: string; status: string };
    expect(dev.status).toBe('revoked');
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM tokens WHERE revoked_at IS NULL').get()).toEqual({ n: 0 });
    expect((await bearer(s.app, t2.access_token)).statusCode).toBe(401);
    expect((await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: t2.refresh_token })).json().error).toBe('invalid_grant');
    const rev = auditRows(s.db, 'device.revoked');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ actor_type: 'system', device_id: dev.id, meta: JSON.stringify({ cause: 'refresh_reuse' }) });
  });

  it('refresh token expires after 30 days', async () => {
    const s = await setup();
    const { code } = await s.approve();
    const t = (await s.exchange(code)).json();
    s.clock.advance(30 * 24 * 3600_000 + 1);
    expect((await tokenReq(s.app, { grant_type: 'refresh_token', refresh_token: t.refresh_token })).json().error).toBe('invalid_grant');
  });
});
