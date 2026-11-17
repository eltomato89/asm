import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revokeDevice } from '../src/devices/service.js';
import { issueTokens } from '../src/oauth/token.js';
import { enableAutoMode } from '../src/requests/automode.js';
import { decideRequest } from '../src/requests/service.js';
import { archiveSecret, createSecret } from '../src/secrets/service.js';
import { cancelStandingRequestsForDevice, decideStandingRequest, expireStandingRequests } from '../src/standing/requests.js';
import { setStandingApproval, standingSummaryForDevice } from '../src/standing/service.js';
import { addMember, createVault, personalVaultId } from '../src/vaults/service.js';
import { FORBIDDEN_RESPONSE_KEYS, allKeys, auditRows, pairDevice, world } from './helpers/fixtures.js';

const MIN = 60_000;
const SECRET_VALUE = 'sk_live_MCP_TOPSECRET_42';
const PLAIN_VALUE = 'pt_PLAINTEXT_ONLY_VIA_AWAIT';
const TOOL_NAMES = ['archive_secret', 'await_request', 'create_secret', 'list_vaults', 'request_secret', 'request_standing_approval', 'search_secrets', 'update_secret', 'whoami'];
const INSTRUCTIONS = (id: string) => `Run: asm run --grant ${id} -- <command>  |  asm write --grant ${id} <file>`;
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const LIST_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { awaitTimeoutMs?: number; config?: Record<string, unknown> } = {}) {
  const w = await world({ app: { mcpAwaitTimeoutMs: opts.awaitTimeoutMs ?? 200, config: opts.config as never } });
  await w.app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => w.app.close());
  const base = `http://127.0.0.1:${(w.app.server.address() as AddressInfo).port}`;
  const secret = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Key', envName: 'STRIPE_KEY', description: 'payments', value: SECRET_VALUE });
  const plain = createSecret(w.ctx, w.alice.actor, { title: 'Plain Token', envName: 'PLAIN_TOKEN', value: PLAIN_VALUE, allowPlaintextToAgent: true });
  const dev = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'alice-laptop' });
  /** Every tool result text seen in this test (for leak scans). */
  const seen: { tool: string; text: string }[] = [];

  async function connect(token = dev.accessToken): Promise<Client> {
    const client = new Client({ name: 'asm-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    cleanups.push(() => client.close());
    return client;
  }
  const client = await connect();

  async function call(name: string, args: Record<string, unknown>, c = client): Promise<ToolResult> {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown };
    const text = r.content[0]!.text;
    seen.push({ tool: name, text });
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(r.structuredContent).toEqual(data);
    return { isError: r.isError === true, data, text };
  }
  const inject = (headers: Record<string, string>, method: 'POST' | 'GET' | 'DELETE' = 'POST') =>
    method === 'POST'
      ? w.app.inject({ method, url: '/mcp', headers: { ...MCP_HEADERS, ...headers }, payload: LIST_BODY })
      : w.app.inject({ method, url: '/mcp', headers: { accept: MCP_HEADERS.accept, ...headers } });
  const approve = (requestId: string) => decideRequest(w.ctx, { requestId, userId: w.alice.id, decision: 'approve' });
  return { w, base, secret, plain, dev, client, connect, call, inject, approve, seen };
}

const P = { project: 'Foo' };

describe('mcp: transport and auth', () => {
  it('rejects requests without a token with 401 + WWW-Authenticate', async () => {
    const { inject } = await setup();
    const res = await inject({});
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer resource_metadata="https:\/\/asm\.test\/\.well-known\/oauth-protected-resource/);
  });

  it('rejects a foreign Origin with 403 (DNS rebinding protection)', async () => {
    const { inject, dev } = await setup();
    const res = await inject({ authorization: `Bearer ${dev.accessToken}`, origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const ok = await inject({ authorization: `Bearer ${dev.accessToken}`, origin: 'https://asm.test' });
    expect(ok.statusCode).toBe(200);
  });

  it('MCP responses are not cacheable (cache-control: no-store)', async () => {
    const { inject, dev } = await setup();
    const res = await inject({ authorization: `Bearer ${dev.accessToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects devices of kind cli with 403 forbidden_device_kind', async () => {
    const { w, inject } = await setup();
    const cli = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli' });
    const res = await inject({ authorization: `Bearer ${cli.accessToken}` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_device_kind' });
  });

  it('GET and DELETE are 405 with Allow: POST (stateless, no server stream)', async () => {
    const { inject, dev } = await setup();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await inject({ authorization: `Bearer ${dev.accessToken}` }, method);
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('a device revoked mid-session gets 401', async () => {
    const { w, call, client, dev, inject } = await setup();
    expect((await call('whoami', P)).isError).toBe(false);
    revokeDevice(w.ctx, dev.deviceId, { type: 'user', userId: w.alice.id });
    await expect(client.callTool({ name: 'whoami', arguments: P })).rejects.toMatchObject({ code: 401, message: expect.stringMatching(/invalid_token/) });
    expect((await inject({ authorization: `Bearer ${dev.accessToken}` })).statusCode).toBe(401);
  });

  it('rate limits /mcp at 120 requests per minute per device', async () => {
    const { inject, dev } = await setup();
    const auth = { authorization: `Bearer ${dev.accessToken}` };
    for (let i = 0; i < 120; i++) await inject(auth);
    const res = await inject(auth);
    expect(res.statusCode).toBe(429);
  }, 30_000); // 120+ sequential requests; slow when the whole monorepo suite runs in parallel
});

describe('mcp: tool list and validation', () => {
  it('lists exactly the 9 tools; no reactivate/delete tool; no plaintext flag in inputs', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    for (const t of tools) {
      expect(t.name).not.toMatch(/delete|unarchive|restore|reactivate/);
      expect(t.description!.length).toBeGreaterThan(40);
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props).not.toContain('allow_plaintext_to_agent');
      expect(props).not.toContain('allowPlaintextToAgent');
      if (t.name === 'await_request') expect(t.inputSchema.required).toEqual(['request_id']);
      else expect(t.inputSchema.required).toContain('project');
    }
    const req = tools.find((t) => t.name === 'request_secret')!;
    expect(req.description).toMatch(/cli/);
    expect(req.description).toMatch(/[Nn]ever print/);
    const create = tools.find((t) => t.name === 'create_secret')!;
    expect(create.description).toMatch(/transcript/);
    expect(create.description).toMatch(/generate/);
    expect(create.description).toMatch(/--from-env/);
    expect(tools.find((t) => t.name === 'archive_secret')!.description).toMatch(/replaced/);
  });

  it('every tool except await_request requires project', async () => {
    const { call, secret } = await setup();
    const args: Record<string, Record<string, unknown>> = {
      search_secrets: { query: 'stripe' },
      request_secret: { secret_id: secret.id, reason: 'deploy' },
      create_secret: { title: 'X', description: 'x', reason: 'r', generate: { length: 32 } },
      update_secret: { secret_id: secret.id, reason: 'r', title: 'Y' },
      archive_secret: { secret_id: secret.id, reason: 'r' },
      list_vaults: {},
      whoami: {},
      request_standing_approval: { vault_ids: ['vlt_x'], days: 3, reason: 'r' },
    };
    for (const [tool, a] of Object.entries(args)) {
      const r = await call(tool, a);
      expect(r.isError, tool).toBe(true);
      expect(r.data.error, tool).toBe('invalid_request');
      expect(JSON.stringify(r.data.issues), tool).toContain('"project"');
      const empty = await call(tool, { ...a, project: '' });
      expect(empty.isError, tool).toBe(true);
    }
  });

  it('archive_secret without reason fails', async () => {
    const { call, secret } = await setup();
    const r = await call('archive_secret', { secret_id: secret.id, ...P });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe('invalid_request');
    expect(JSON.stringify(r.data.issues)).toContain('"reason"');
  });

  it('create_secret/update_secret with allow_plaintext_to_agent → field_not_allowed', async () => {
    const { call, secret } = await setup();
    for (const key of ['allow_plaintext_to_agent', 'allowPlaintextToAgent']) {
      const c = await call('create_secret', { title: 'X', description: 'x', reason: 'r', generate: { length: 32 }, ...P, [key]: true });
      expect(c).toMatchObject({ isError: true, data: { error: 'field_not_allowed' } });
      const u = await call('update_secret', { secret_id: secret.id, reason: 'r', ...P, [key]: true });
      expect(u).toMatchObject({ isError: true, data: { error: 'field_not_allowed' } });
    }
  });
});

describe('mcp: search', () => {
  it('lists secrets used by this project first with used_by_this_project, audits the query, never values', async () => {
    const { w, call, secret, approve } = await setup();
    w.clock.advance(MIN);
    const newer = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Webhook', value: 'whsec_x' });
    const req = await call('request_secret', { secret_id: secret.id, project: 'foo', reason: 'deploy' });
    approve(req.data.request_id as string);

    const r = await call('search_secrets', { query: 'stripe', project: 'Foo' });
    expect(r.isError).toBe(false);
    const list = r.data.secrets as { id: string; used_by_this_project: boolean }[];
    expect(list.map((s) => s.id)).toEqual([secret.id, newer.id]);
    expect(list[0]!.used_by_this_project).toBe(true);
    expect(list[1]!.used_by_this_project).toBe(false);
    for (const k of FORBIDDEN_RESPONSE_KEYS) expect(allKeys(r.data).has(k)).toBe(false);
    expect(r.text).not.toContain(SECRET_VALUE);

    const audit = auditRows(w.db, 'secret.searched');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'device', project: 'foo' });
    expect(JSON.parse(audit[0]!.meta as string)).toEqual({ query: 'stripe' });
  });

  it('finds secrets by env name', async () => {
    const { w, call } = await setup();
    const gh = createSecret(w.ctx, w.alice.actor, { title: 'Deploy credentials', envName: 'GITHUB_TOKEN', value: 'v' });
    const r = await call('search_secrets', { query: 'GITHUB_TOKEN', ...P });
    expect((r.data.secrets as { id: string }[]).map((s) => s.id)).toEqual([gh.id]);
  });

  it('ranks secrets used by this project first before the 50-result limit', async () => {
    const { w, call, approve } = await setup();
    const old = createSecret(w.ctx, w.alice.actor, { title: 'Api key old', value: 'v0' });
    const req = await call('request_secret', { secret_id: old.id, project: 'foo', reason: 'deploy' });
    approve(req.data.request_id as string);
    for (let i = 0; i < 55; i++) {
      w.clock.advance(1000);
      createSecret(w.ctx, w.alice.actor, { title: `Api key ${i}`, value: 'v' });
    }
    const r = await call('search_secrets', { query: 'api', ...P });
    const list = r.data.secrets as { id: string; used_by_this_project: boolean }[];
    expect(list).toHaveLength(50);
    expect(list[0]).toMatchObject({ id: old.id, used_by_this_project: true });
    expect(list.slice(1).every((s) => !s.used_by_this_project)).toBe(true);
  });

  it('includes archived secrets (with archived.reason) only with include_archived', async () => {
    const { w, call, secret } = await setup();
    archiveSecret(w.ctx, w.alice.actor, secret.id, { reason: 'replaced by new key' });
    const def = await call('search_secrets', { query: 'stripe', ...P });
    expect(def.data.secrets).toEqual([]);
    const all = await call('search_secrets', { query: 'stripe', include_archived: true, ...P });
    const list = all.data.secrets as { id: string; archived: { reason: string } }[];
    expect(list.map((s) => s.id)).toEqual([secret.id]);
    expect(list[0]!.archived.reason).toBe('replaced by new key');
  });
});

describe('mcp: read requests', () => {
  it('request → pending; await pending → hint; after approval await → grant_id + instructions, no value', async () => {
    const { call, secret, approve } = await setup();
    const req = await call('request_secret', { secret_id: secret.id, reason: 'run migrations', ...P });
    expect(req.isError).toBe(false);
    expect(req.data).toMatchObject({ status: 'pending' });
    expect(req.data.request_id).toMatch(/^req_/);
    expect(typeof req.data.expires_at).toBe('string');

    const pending = await call('await_request', { request_id: req.data.request_id });
    expect(pending.data).toEqual({ status: 'pending', hint: 'Call await_request again' });

    approve(req.data.request_id as string);
    const done = await call('await_request', { request_id: req.data.request_id });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('approved');
    expect(done.data.grant_id).toMatch(/^grt_/);
    expect(done.data.env_name).toBe('STRIPE_KEY');
    expect(typeof done.data.expires_at).toBe('string');
    expect(done.data.instructions).toBe(INSTRUCTIONS(done.data.grant_id as string));
    expect(done.data).not.toHaveProperty('value');
    expect(done.text).not.toContain(SECRET_VALUE);
  });

  it('await_request long-polls until the decision', async () => {
    const { call, secret, approve } = await setup({ awaitTimeoutMs: 10_000 });
    const req = await call('request_secret', { secret_id: secret.id, reason: 'deploy', ...P });
    const waiting = call('await_request', { request_id: req.data.request_id });
    await new Promise((r) => setTimeout(r, 100));
    approve(req.data.request_id as string);
    const done = await waiting;
    expect(done.data.status).toBe('approved');
    expect(done.data.grant_id).toMatch(/^grt_/);
  });

  it('a client disconnect ends the long-poll (no leaked waiters)', async () => {
    const { base, dev, call, secret, approve } = await setup({ awaitTimeoutMs: 30_000 });
    const req = await call('request_secret', { secret_id: secret.id, reason: 'deploy', ...P });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'await_request', arguments: { request_id: req.data.request_id } } });
    const reqs = Array.from({ length: 20 }, () =>
      request(`${base}/mcp`, { method: 'POST', agent: false, headers: { ...MCP_HEADERS, authorization: `Bearer ${dev.accessToken}` } })
        .on('error', () => {})
        .end(body),
    );
    await new Promise((r) => setTimeout(r, 200));
    reqs.forEach((r) => r.destroy());
    await new Promise((r) => setTimeout(r, 100));
    // Waiters are counted per device: with 20 leaked waiters on the first request (MAX_WAITERS_PER_DEVICE)
    // awaiting another request would fail with too_many_waiters.
    const other = await call('request_secret', { secret_id: secret.id, reason: 'deploy again', ...P });
    approve(other.data.request_id as string);
    const done = await call('await_request', { request_id: other.data.request_id });
    expect(done.data.status).toBe('approved');
  });

  it('plaintext delivery returns the value once (audited); a second await → value_already_delivered', async () => {
    const { w, call, plain, approve } = await setup();
    const req = await call('request_secret', { secret_id: plain.id, reason: 'configure tool', delivery: 'plaintext', ...P });
    approve(req.data.request_id as string);
    const first = await call('await_request', { request_id: req.data.request_id });
    expect(first).toMatchObject({ isError: false, data: { status: 'approved', value: PLAIN_VALUE } });
    expect(auditRows(w.db, 'secret.plaintext_delivered')).toHaveLength(1);
    const second = await call('await_request', { request_id: req.data.request_id });
    expect(second).toMatchObject({ isError: true, data: { status: 'approved', error: 'value_already_delivered' } });
    expect(second.text).not.toContain(PLAIN_VALUE);
  });

  it('plaintext delivery on a secret without the flag → plaintext_not_allowed', async () => {
    const { call, secret } = await setup();
    const r = await call('request_secret', { secret_id: secret.id, reason: 'x', delivery: 'plaintext', ...P });
    expect(r).toMatchObject({ isError: true, data: { error: 'plaintext_not_allowed' } });
  });

  it('auto mode: request_secret returns the approved result immediately', async () => {
    const { w, call, secret } = await setup();
    enableAutoMode(w.ctx, w.alice.id, 30);
    const r = await call('request_secret', { secret_id: secret.id, reason: 'deploy', ...P });
    expect(r.data.status).toBe('approved');
    expect(r.data.request_id).toMatch(/^req_/);
    expect(r.data.grant_id).toMatch(/^grt_/);
    expect(r.data.instructions).toBe(INSTRUCTIONS(r.data.grant_id as string));
    expect(r.data).not.toHaveProperty('value');
    expect(r.data.approved_by).toBe('auto_mode');
  });

  it('auto mode + plaintext: request_secret returns the value once (audited); await_request → value_already_delivered', async () => {
    const { w, call, plain } = await setup();
    enableAutoMode(w.ctx, w.alice.id, 30);
    const r = await call('request_secret', { secret_id: plain.id, reason: 'configure tool', delivery: 'plaintext', ...P });
    expect(r).toMatchObject({ isError: false, data: { status: 'approved', value: PLAIN_VALUE } });
    expect(r.data.request_id).toMatch(/^req_/);
    expect(r.data).not.toHaveProperty('grant_id');
    const delivered = auditRows(w.db, 'secret.plaintext_delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ secret_id: plain.id, actor_type: 'device' });
    const again = await call('await_request', { request_id: r.data.request_id });
    expect(again).toMatchObject({ isError: true, data: { status: 'approved', error: 'value_already_delivered' } });
    expect(again.text).not.toContain(PLAIN_VALUE);
    expect(auditRows(w.db, 'secret.plaintext_delivered')).toHaveLength(1);
  });

  it("another user's device cannot see or use alice's secret or request ids (not_found, no metadata)", async () => {
    const { w, call, secret, connect } = await setup();
    const aliceReq = await call('request_secret', { secret_id: secret.id, reason: 'x', ...P });
    const bobDev = pairDevice(w.ctx, { userId: w.bob.id, kind: 'mcp', name: 'bob-laptop' });
    const bob = await connect(bobDev.accessToken);
    const attempts: [string, Record<string, unknown>][] = [
      ['request_secret', { secret_id: secret.id, reason: 'x', ...P }],
      ['request_secret', { secret_id: secret.id, reason: 'x', delivery: 'plaintext', ...P }],
      ['update_secret', { secret_id: secret.id, reason: 'x', title: 'pwned', ...P }],
      ['archive_secret', { secret_id: secret.id, reason: 'x', ...P }],
      ['await_request', { request_id: aliceReq.data.request_id }],
    ];
    for (const [tool, args] of attempts) {
      const r = await call(tool, args, bob);
      expect(r, tool).toEqual({ isError: true, data: { error: 'not_found' }, text: JSON.stringify({ error: 'not_found' }) });
      for (const leak of ['Stripe', 'STRIPE_KEY', secret.vaultId, SECRET_VALUE]) expect(r.text).not.toContain(leak);
    }
    const found = await call('search_secrets', { query: 'stripe', ...P }, bob);
    expect(found.data.secrets).toEqual([]);
    expect(w.db.$client.prepare('SELECT count(*) AS n FROM access_requests WHERE device_id = ?').get(bobDev.deviceId)).toEqual({ n: 0 });
    expect(w.db.$client.prepare('SELECT title, archived_at FROM secrets WHERE id = ?').get(secret.id)).toEqual({ title: 'Stripe Key', archived_at: null });
  });

  it('request_secret on an archived secret → secret_archived', async () => {
    const { w, call, secret } = await setup();
    archiveSecret(w.ctx, w.alice.actor, secret.id, { reason: 'gone' });
    const r = await call('request_secret', { secret_id: secret.id, reason: 'x', ...P });
    expect(r).toMatchObject({ isError: true, data: { error: 'secret_archived' } });
  });

  it('denied requests report status and cause', async () => {
    const { w, call, secret } = await setup();
    const a = await call('request_secret', { secret_id: secret.id, reason: 'x', ...P });
    decideRequest(w.ctx, { requestId: a.data.request_id as string, userId: w.alice.id, decision: 'deny' });
    expect((await call('await_request', { request_id: a.data.request_id })).data).toEqual({ status: 'denied' });
    const b = await call('request_secret', { secret_id: secret.id, reason: 'x', ...P });
    archiveSecret(w.ctx, w.alice.actor, secret.id, { reason: 'gone' });
    expect((await call('await_request', { request_id: b.data.request_id })).data).toEqual({ status: 'denied', cause: 'archived' });
  });

  it('only the requesting device may await', async () => {
    const { w, call, secret, connect } = await setup();
    const req = await call('request_secret', { secret_id: secret.id, reason: 'x', ...P });
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'other' });
    const c2 = await connect(other.accessToken);
    const r = await call('await_request', { request_id: req.data.request_id }, c2);
    expect(r).toMatchObject({ isError: true, data: { error: 'not_found' } });
  });
});

describe('mcp: create, update, archive, vaults, whoami', () => {
  it('create_secret creates immediately without approval', async () => {
    const { w, call } = await setup();
    const r = await call('create_secret', { title: 'DB Password', description: 'staging db', env_name: 'DB_PASSWORD', generate: { length: 32 }, reason: 'new service', ...P });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ secret_id: expect.stringMatching(/^sec_/), version: 1 });
    const row = w.db.$client.prepare('SELECT created_by_type FROM secrets WHERE id = ?').get(r.data.secret_id) as { created_by_type: string };
    expect(row.created_by_type).toBe('device');
  });

  it('update_secret → pending; after approval await_request returns the new version', async () => {
    const { call, secret, approve } = await setup();
    const r = await call('update_secret', { secret_id: secret.id, generate: { length: 32 }, reason: 'rotate', ...P });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: 'pending' });
    expect(r.data.request_id).toMatch(/^req_/);
    expect(typeof r.data.expires_at).toBe('string');
    approve(r.data.request_id as string);
    const done = await call('await_request', { request_id: r.data.request_id });
    expect(done.data).toEqual({ status: 'approved', version: 2 });
  });

  it('archive_secret archives immediately', async () => {
    const { call, secret } = await setup();
    const r = await call('archive_secret', { secret_id: secret.id, reason: 'service removed', ...P });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ secret_id: secret.id, archived_at: expect.any(String) });
    const again = await call('archive_secret', { secret_id: secret.id, reason: 'again', ...P });
    expect(again).toMatchObject({ isError: true, data: { error: 'already_archived' } });
  });

  it('list_vaults and whoami', async () => {
    const { w, call, dev } = await setup();
    const v = await call('list_vaults', P);
    expect((v.data.vaults as { personal: boolean }[]).some((x) => x.personal)).toBe(true);
    const me = await call('whoami', P);
    expect(me.data).toEqual({
      device: { id: dev.deviceId, name: 'alice-laptop', kind: 'mcp' },
      user: { id: w.alice.id, username: 'alice' },
      auto_mode: { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null },
      standing_approval: null,
      default_vault: { id: personalVaultId(w.db, w.alice.id), name: 'Personal' },
      attached_cli: [],
      standing_request: { allowed: true, max_days: 14 },
    });
    const project = w.db.$client.prepare("SELECT last_seen FROM projects WHERE slug = 'foo'").get();
    expect(project).toBeDefined();
  });
});

describe('mcp: attached CLIs', () => {
  it('whoami lists the approved CLIs attached to this device', async () => {
    const { w, call, dev } = await setup();
    const cli = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'laptop-cli' });
    const revoked = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'old-cli' });
    w.db.$client.prepare("UPDATE devices SET hostname = 'box-1' WHERE id = ?").run(cli.deviceId);
    w.db.$client.prepare('UPDATE devices SET linked_to_device_id = ? WHERE id IN (?, ?)').run(dev.deviceId, cli.deviceId, revoked.deviceId);
    w.db.$client.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(revoked.deviceId);
    expect((await call('whoami', P)).data.attached_cli).toEqual([{ name: 'laptop-cli', hostname: 'box-1' }]);
  });
});

describe('mcp: default vault', () => {
  it('create_secret without vault_id lands in the device default vault; whoami reports it; explicit vault_id still wins', async () => {
    const { w, call, dev } = await setup();
    const team = createVault(w.ctx, w.bob.id, 'Team');
    addMember(w.ctx, w.bob.id, team.id, { username: 'alice' });
    w.db.$client.prepare('UPDATE devices SET default_vault_id = ? WHERE id = ?').run(team.id, dev.deviceId);
    expect((await call('whoami', P)).data.default_vault).toEqual({ id: team.id, name: 'Team' });
    const vaultOf = (id: unknown) => (w.db.$client.prepare('SELECT vault_id FROM secrets WHERE id = ?').get(id) as { vault_id: string }).vault_id;
    const a = await call('create_secret', { title: 'A', description: 'a', reason: 'r', generate: { length: 16 }, ...P });
    expect(vaultOf(a.data.secret_id)).toBe(team.id);
    const personal = personalVaultId(w.db, w.alice.id);
    const b = await call('create_secret', { title: 'B', description: 'b', reason: 'r', generate: { length: 16 }, vault_id: personal, ...P });
    expect(vaultOf(b.data.secret_id)).toBe(personal);
  });
});

describe('mcp: standing approval', () => {
  const DAY = 24 * 60 * MIN;
  const stand = (t: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown> = {}) =>
    setStandingApproval(t.w.ctx, t.w.alice.id, t.dev.deviceId, { until: t.w.clock.now() + 7 * DAY, scope: 'all', ...input } as never, {});

  it('whoami shows the standing approval (no secret ids)', async () => {
    const t = await setup();
    stand(t, { scope: 'list', secretIds: [t.secret.id], allowUpdates: true });
    const me = await t.call('whoami', P);
    expect(me.data.standing_approval).toEqual({
      active: true, until: new Date(t.w.clock.now() + 7 * DAY).toISOString(), covers_updates: true, scope: 'list',
    });
    expect(me.text).not.toContain(t.secret.id);
  });

  it('request_secret is approved immediately with approved_by standing_approval; manual approvals carry no approved_by', async () => {
    const t = await setup();
    const manual = await t.call('request_secret', { secret_id: t.secret.id, reason: 'deploy', ...P });
    t.approve(manual.data.request_id as string);
    const done = await t.call('await_request', { request_id: manual.data.request_id });
    expect(done.data.status).toBe('approved');
    expect(done.data).not.toHaveProperty('approved_by');

    stand(t);
    const r = await t.call('request_secret', { secret_id: t.secret.id, reason: 'deploy', ...P });
    expect(r.data).toMatchObject({ status: 'approved', approved_by: 'standing_approval' });
    expect(r.data.grant_id).toMatch(/^grt_/);
    expect(r.text).not.toContain(SECRET_VALUE);
  });

  it('expired with renew: pending with a renewal hint', async () => {
    const t = await setup();
    stand(t, { until: t.w.clock.now() + DAY, afterExpiry: 'renew', renewDays: 3 });
    t.w.clock.advance(DAY);
    const c = await t.connect(issueTokens(t.w.ctx, t.dev.deviceId).accessToken); // the original access token has expired
    const r = await t.call('request_secret', { secret_id: t.secret.id, reason: 'deploy', ...P }, c);
    expect(r.data.status).toBe('pending');
    expect(r.data.hint).toMatch(/standing approval has expired/);
  });
});

describe('mcp: request_standing_approval', () => {
  const DAY = 24 * 60 * MIN;
  const propose = (t: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown> = {}) =>
    t.call('request_standing_approval', {
      vault_ids: [personalVaultId(t.w.db, t.w.alice.id)], days: 7, reason: 'daily deploys this sprint', ...P, ...args,
    });
  const decide = (t: Awaited<ReturnType<typeof setup>>, id: string, decision: 'approve' | 'deny', settings?: Record<string, unknown>) =>
    decideStandingRequest(t.w.ctx, { id, userId: t.w.alice.id, decision, ...(settings ? { settings: settings as never } : {}) });

  it('description stresses genuine repeated need and its limits', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const d = tools.find((x) => x.name === 'request_standing_approval')!;
    expect(d.description).toMatch(/genuine, repeated need/);
    expect(d.description).toMatch(/reads only/);
    expect(d.description).toMatch(/24 h/);
    expect(d.description).toMatch(/narrow/);
    expect(d.description).toMatch(/whoami\.standing_request/);
    const props = Object.keys(d.inputSchema.properties ?? {});
    for (const k of ['scope', 'allow_updates', 'include_created']) expect(props).not.toContain(k);
    expect(tools.find((x) => x.name === 'await_request')!.description).toMatch(/srq_/);
  });

  it('creates a pending proposal (srq_) with a hint; audited; vault or secret scope', async () => {
    const t = await setup();
    const r = await propose(t, { after_expiry: 'renew', renew_days: 5 });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      request_id: expect.stringMatching(/^srq_/), status: 'pending', expires_at: new Date(t.w.clock.now() + 30 * MIN).toISOString(),
      hint: 'Ask the user to review it in ASM, then call await_request with this request_id',
    });
    const row = t.w.db.$client.prepare('SELECT * FROM standing_requests WHERE id = ?').get(r.data.request_id) as Record<string, unknown>;
    expect(row).toMatchObject({ device_id: t.dev.deviceId, scope: 'vaults', days: 7, after_expiry: 'renew', renew_days: 5, status: 'pending' });
    expect(auditRows(t.w.db, 'standing_request.created')).toHaveLength(1);

    cancelStandingRequestsForDevice(t.w.ctx, t.dev.deviceId, 'superseded');
    const s = await propose(t, { vault_ids: undefined, secret_ids: [t.secret.id] });
    expect(s.isError).toBe(false);
    const row2 = t.w.db.$client.prepare('SELECT scope, secret_ids, after_expiry, renew_days FROM standing_requests WHERE id = ?').get(s.data.request_id);
    expect(row2).toEqual({ scope: 'list', secret_ids: JSON.stringify([t.secret.id]), after_expiry: 'ask', renew_days: null });
  });

  it('scope / allow_updates / include_created → field_not_allowed with a hint', async () => {
    const t = await setup();
    for (const [key, v] of [['scope', 'all'], ['allow_updates', true], ['include_created', true], ['allowUpdates', true]] as const) {
      const r = await propose(t, { [key]: v });
      expect(r, key).toMatchObject({ isError: true, data: { error: 'field_not_allowed', hint: 'agent proposals never cover changes or all secrets' } });
    }
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM standing_requests').get()).toEqual({ n: 0 });
  });

  it('exactly one of vault_ids / secret_ids; list sizes and days validated', async () => {
    const t = await setup();
    const both = await propose(t, { secret_ids: [t.secret.id] });
    expect(both).toMatchObject({ isError: true, data: { error: 'invalid_request' } });
    const none = await propose(t, { vault_ids: undefined });
    expect(none).toMatchObject({ isError: true, data: { error: 'invalid_request' } });
    for (const bad of [{ vault_ids: [] }, { vault_ids: Array.from({ length: 11 }, (_, i) => `vlt_${i}`) }, { days: 0 }, { days: 1.5 }, { after_expiry: 'never' }]) {
      expect((await propose(t, bad)).data.error, JSON.stringify(bad)).toBe('invalid_request');
    }
    expect((await propose(t, { renew_days: 3 })).data.error).toBe('invalid_request'); // renew_days without renew
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM standing_requests').get()).toEqual({ n: 0 });
  });

  it('maps service errors: invalid_days, vault_not_found, secret_not_found, secret_archived, pending (with request_id), active', async () => {
    const t = await setup();
    expect((await propose(t, { days: 15 })).data).toMatchObject({ error: 'invalid_days' });
    const foreign = createVault(t.w.ctx, t.w.bob.id, 'Bob only');
    expect((await propose(t, { vault_ids: [foreign.id] })).data).toMatchObject({ error: 'vault_not_found' });
    expect((await propose(t, { vault_ids: undefined, secret_ids: ['sec_nope'] })).data).toMatchObject({ error: 'secret_not_found' });
    archiveSecret(t.w.ctx, t.w.alice.actor, t.plain.id, { reason: 'old' });
    expect((await propose(t, { vault_ids: undefined, secret_ids: [t.plain.id] })).data).toMatchObject({ error: 'secret_archived' });

    const first = await propose(t);
    const again = await propose(t);
    expect(again).toMatchObject({ isError: true, data: { error: 'standing_request_pending', request_id: first.data.request_id } });
    expect((await t.call('whoami', P)).data.standing_request).toEqual({
      allowed: false, reason: 'pending', pending_request_id: first.data.request_id, max_days: 14,
    });

    decide(t, first.data.request_id as string, 'approve');
    expect((await propose(t)).data).toMatchObject({ error: 'standing_active' });
    expect((await t.call('whoami', P)).data.standing_request).toMatchObject({ allowed: false, reason: 'active' });
  });

  it('disabled (max days 0): standing_requests_disabled; whoami says so', async () => {
    const t = await setup({ config: { standingRequestMaxDays: 0 } });
    expect((await propose(t)).data).toMatchObject({ error: 'standing_requests_disabled' });
    expect((await t.call('whoami', P)).data.standing_request).toEqual({ allowed: false, reason: 'disabled', max_days: 0 });
  });

  it('await_request srq_: pending → hint; approved (narrowed) → standing_approval with adjusted', async () => {
    const t = await setup();
    const personal = personalVaultId(t.w.db, t.w.alice.id);
    const team = createVault(t.w.ctx, t.w.alice.id, 'Team');
    const r = await propose(t, { vault_ids: [personal, team.id], after_expiry: 'renew', renew_days: 7 });
    const id = r.data.request_id as string;
    expect((await t.call('await_request', { request_id: id })).data).toEqual({ status: 'pending', hint: 'Call await_request again' });
    decide(t, id, 'approve', { scope: 'vaults', vaultIds: [team.id], secretIds: [], days: 3, afterExpiry: 'ask', renewDays: null });
    const done = await t.call('await_request', { request_id: id });
    expect(done.isError).toBe(false);
    const until = standingSummaryForDevice(t.w.ctx, t.dev.deviceId)!.until;
    expect(until).toBe(t.w.clock.now() + 3 * DAY);
    expect(done.data).toEqual({
      status: 'approved',
      standing_approval: { until: new Date(until).toISOString(), scope: 'vaults', vault_ids: [team.id], after_expiry: 'ask', adjusted: true },
    });
  });

  it('await_request srq_ long-polls until the decision', async () => {
    const t = await setup({ awaitTimeoutMs: 5000 });
    const r = await propose(t, { vault_ids: undefined, secret_ids: [t.secret.id] });
    const id = r.data.request_id as string;
    setTimeout(() => decide(t, id, 'approve'), 50);
    const done = await t.call('await_request', { request_id: id });
    expect(done.data).toMatchObject({
      status: 'approved', standing_approval: { scope: 'list', secret_ids: [t.secret.id], after_expiry: 'ask', adjusted: false },
    });
  });

  it('await_request srq_: denied → retry_after; then cooldown on the next proposal and in whoami', async () => {
    const t = await setup();
    const r = await propose(t);
    decide(t, r.data.request_id as string, 'deny');
    const retry = new Date(t.w.clock.now() + DAY).toISOString();
    expect((await t.call('await_request', { request_id: r.data.request_id })).data).toEqual({ status: 'denied', retry_after: retry });
    const next = await propose(t);
    expect(next).toMatchObject({ isError: true, data: { error: 'standing_request_cooldown' } });
    expect((await t.call('whoami', P)).data.standing_request).toEqual({ allowed: false, reason: 'cooldown', retry_after: retry, max_days: 14 });
  });

  it('await_request srq_: expired and cancelled (with cause)', async () => {
    const t = await setup();
    const r = await propose(t);
    t.w.clock.advance(31 * MIN);
    expireStandingRequests(t.w.ctx);
    expect((await t.call('await_request', { request_id: r.data.request_id })).data).toEqual({ status: 'expired' });

    const c = await propose(t);
    expect(c.isError).toBe(false);
    cancelStandingRequestsForDevice(t.w.ctx, t.dev.deviceId, 'superseded');
    expect((await t.call('await_request', { request_id: c.data.request_id })).data).toEqual({ status: 'cancelled', cause: 'superseded' });
  });

  it("another device cannot await someone else's proposal", async () => {
    const t = await setup();
    const r = await propose(t);
    const other = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'mcp', name: 'other' });
    const c = await t.connect(other.accessToken);
    const res = await t.call('await_request', { request_id: r.data.request_id }, c);
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe('not_found');
  });
});

describe('mcp: no value leaks', () => {
  it('a full flow never returns secret values except via plaintext await_request', async () => {
    const { w, call, secret, plain, approve, seen } = await setup();
    await call('whoami', P);
    await call('list_vaults', P);
    await call('search_secrets', { query: '', include_archived: true, ...P });
    const r1 = await call('request_secret', { secret_id: secret.id, reason: 'deploy', ...P });
    approve(r1.data.request_id as string);
    await call('await_request', { request_id: r1.data.request_id });
    const r2 = await call('request_secret', { secret_id: plain.id, reason: 'configure', delivery: 'plaintext', ...P });
    approve(r2.data.request_id as string);
    await call('await_request', { request_id: r2.data.request_id });
    await call('await_request', { request_id: r2.data.request_id });
    const u = await call('update_secret', { secret_id: secret.id, value: 'new_value_NEVER_RETURNED', reason: 'rotate', ...P });
    approve(u.data.request_id as string);
    await call('await_request', { request_id: u.data.request_id });
    await call('create_secret', { title: 'C', description: 'c', value: 'created_value_NEVER_RETURNED', reason: 'r', ...P });
    await call('archive_secret', { secret_id: secret.id, reason: 'replaced', ...P });
    await call('search_secrets', { query: '', include_archived: true, ...P });
    enableAutoMode(w.ctx, w.alice.id, 30);
    await call('request_secret', { secret_id: plain.id, reason: 'again', ...P });

    let plaintextHits = 0;
    for (const { tool, text } of seen) {
      for (const v of [SECRET_VALUE, 'new_value_NEVER_RETURNED', 'created_value_NEVER_RETURNED']) expect(text, tool).not.toContain(v);
      if (text.includes(PLAIN_VALUE)) {
        expect(tool).toBe('await_request');
        plaintextHits++;
      }
    }
    expect(plaintextHits).toBe(1);
  });
});
