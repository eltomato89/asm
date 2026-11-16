import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { revokeDevice } from '../src/devices/service.js';
import { enableAutoMode } from '../src/requests/automode.js';
import { decideRequest } from '../src/requests/service.js';
import { archiveSecret, createSecret } from '../src/secrets/service.js';
import { FORBIDDEN_RESPONSE_KEYS, allKeys, auditRows, pairDevice, world } from './helpers/fixtures.js';

const MIN = 60_000;
const SECRET_VALUE = 'sk_live_MCP_TOPSECRET_42';
const PLAIN_VALUE = 'pt_PLAINTEXT_ONLY_VIA_AWAIT';
const TOOL_NAMES = ['archive_secret', 'await_request', 'create_secret', 'list_vaults', 'request_secret', 'search_secrets', 'update_secret', 'whoami'];
const INSTRUCTIONS = (id: string) => `Run: asm run --grant ${id} -- <command>  |  asm write --grant ${id} <file>`;
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
const LIST_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: { awaitTimeoutMs?: number } = {}) {
  const w = await world({ app: { mcpAwaitTimeoutMs: opts.awaitTimeoutMs ?? 200 } });
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
  });
});

describe('mcp: tool list and validation', () => {
  it('lists exactly the 8 tools; no reactivate/delete tool; no plaintext flag in inputs', async () => {
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
    });
    const project = w.db.$client.prepare("SELECT last_seen FROM projects WHERE slug = 'foo'").get();
    expect(project).toBeDefined();
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
