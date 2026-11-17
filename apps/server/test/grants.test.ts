import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '@asm/shared';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import { enableAutoMode } from '../src/requests/automode.js';
import { revokeDevice } from '../src/devices/service.js';
import { grantIdForRequest } from '../src/requests/grants.js';
import { createRequest, decideRequest } from '../src/requests/service.js';
import { createSecret } from '../src/secrets/service.js';
import { addMember, createVault, removeMember } from '../src/vaults/service.js';
import { auditRows, pairDevice, world, type TestUser } from './helpers/fixtures.js';

const MIN = 60_000;
const VALUE = 'ghp_CLI_TOPSECRET_value_123';
type W = Awaited<ReturnType<typeof world>>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function device(w: W, user: TestUser, kind: 'mcp' | 'cli') {
  const name = `${user.username}-${kind}`;
  const d = pairDevice(w.ctx, { userId: user.id, kind, name });
  const identity: DeviceIdentity = { id: d.deviceId, userId: user.id, kind, name };
  return { ...d, identity };
}

type Method = 'GET' | 'POST';
const call = (w: W, token: string | undefined, method: Method, url: string, payload?: unknown) =>
  w.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

async function setup() {
  const w = await world();
  const secret = createSecret(w.ctx, w.alice.actor, { title: 'GitHub Token', envName: 'GITHUB_TOKEN', value: VALUE });
  const mcp = device(w, w.alice, 'mcp');
  const cli = device(w, w.alice, 'cli');
  /** Approved cli-delivery grant requested by alice's MCP device. */
  const grant = (secretId = secret.id, by = mcp.identity, approver = w.alice.id) => {
    const r = createRequest(w.ctx, { device: by, secretId, project: 'foo', reason: 'deploy', delivery: 'cli' });
    decideRequest(w.ctx, { requestId: r.id, userId: approver, decision: 'approve' });
    return grantIdForRequest(w.db, r.id, by.id)!;
  };
  const redeem = (token: string | undefined, grantId: string, body: unknown = { hostname: 'box-1' }) =>
    call(w, token, 'POST', `/api/grants/${grantId}/redeem`, body);
  return { w, secret, mcp, cli, grant, redeem };
}

describe('POST /api/grants/:id/redeem', () => {
  it('cli device of the same user gets the value (no-store), audited with hostname', async () => {
    const { w, secret, cli, grant, redeem } = await setup();
    const res = await redeem(cli.accessToken, grant());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ secrets: [{ secretId: secret.id, envName: 'GITHUB_TOKEN', value: VALUE }] });
    const row = auditRows(w.db, 'grant.redeemed')[0]!;
    expect(row).toMatchObject({ device_id: cli.deviceId, secret_id: secret.id });
    expect(JSON.parse(String(row.meta))).toMatchObject({ hostname: 'box-1' });
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain(VALUE);
  });

  it("another user's cli device → 403 without value (Review Focus 1)", async () => {
    const { w, grant, redeem } = await setup();
    const bobCli = device(w, w.bob, 'cli');
    const res = await redeem(bobCli.accessToken, grant());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(res.body).not.toContain(VALUE);
    expect(auditRows(w.db, 'grant.redeem_denied')).toHaveLength(1);
  });

  it('second redemption → 410 grant_gone', async () => {
    const { cli, grant, redeem } = await setup();
    const g = grant();
    expect((await redeem(cli.accessToken, g)).statusCode).toBe(200);
    const again = await redeem(cli.accessToken, g);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: 'grant_gone' });
  });

  it('after 16 min → 410 grant_gone', async () => {
    const { w, cli, grant, redeem } = await setup();
    const g = grant();
    w.clock.advance(16 * MIN);
    const res = await redeem(cli.accessToken, g);
    expect(res.statusCode).toBe(410);
    expect(res.body).not.toContain(VALUE);
  });

  it('after losing vault membership → 403 without value (Review Focus 4)', async () => {
    const { w, redeem } = await setup();
    const vault = createVault(w.ctx, w.alice.id, 'Team');
    addMember(w.ctx, w.alice.id, vault.id, { username: 'bob' });
    const shared = createSecret(w.ctx, w.alice.actor, { vaultId: vault.id, title: 'Shared', envName: 'SHARED', value: VALUE });
    const bobMcp = device(w, w.bob, 'mcp');
    const bobCli = device(w, w.bob, 'cli');
    const req = () => {
      const r = createRequest(w.ctx, { device: bobMcp.identity, secretId: shared.id, project: 'foo', reason: 'deploy', delivery: 'cli' });
      decideRequest(w.ctx, { requestId: r.id, userId: w.bob.id, decision: 'approve' });
      return grantIdForRequest(w.db, r.id, bobMcp.deviceId)!;
    };
    // Membership gone without the service hook: redemption re-checks vault access itself.
    const g1 = req();
    w.db.$client.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vault.id, w.bob.id);
    const denied = await redeem(bobCli.accessToken, g1);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'forbidden' });
    expect(JSON.parse(String(auditRows(w.db, 'grant.redeem_denied').at(-1)!.meta))).toMatchObject({ cause: 'no_vault_access' });

    // Regular removal: the hook deletes the grant as well → no value either.
    addMember(w.ctx, w.alice.id, vault.id, { username: 'bob' });
    const g2 = req();
    removeMember(w.ctx, w.alice.id, vault.id, w.bob.id);
    const gone = await redeem(bobCli.accessToken, g2);
    expect([403, 410]).toContain(gone.statusCode);
    expect(gone.body).not.toContain(VALUE);
  });

  it('mcp device → 403 forbidden_device_kind; no token → 401; malformed id → 404', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const g = grant();
    const res = await redeem(mcp.accessToken, g);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_device_kind' });
    expect((await redeem(undefined, g)).statusCode).toBe(401);
    const bad = await redeem(cli.accessToken, 'grt_nope');
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toEqual({ error: 'grant_not_found' });
    // The grant is still usable by the right device.
    expect((await redeem(cli.accessToken, g)).statusCode).toBe(200);
    expect(auditRows(w.db, 'grant.redeemed')).toHaveLength(1);
  });

  it('archived secret → 409 secret_archived', async () => {
    const { w, secret, cli, grant, redeem } = await setup();
    const g = grant();
    // Archive that bypassed the hook (which would delete the grant): redemption still checks.
    w.db.$client.prepare('UPDATE secrets SET archived_at = 1 WHERE id = ?').run(secret.id);
    const res = await redeem(cli.accessToken, g);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'secret_archived' });
  });

  it('works without a body (hostname optional)', async () => {
    const { cli, grant, redeem } = await setup();
    const res = await redeem(cli.accessToken, grant(), undefined);
    expect(res.statusCode).toBe(200);
  });
});

describe('grant redemption within a device group (linked CLI)', () => {
  const link = (w: W, cliId: string, mainId: string | null) =>
    w.db.$client.prepare('UPDATE devices SET linked_to_device_id = ? WHERE id = ?').run(mainId, cliId);

  it('group-restricted main device: an outside CLI is denied (403 wrong_device_group, audited wrong_group), the attached CLI redeems', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli-2' });
    link(w, cli.deviceId, mcp.deviceId);
    const g = grant();
    const denied = await redeem(other.accessToken, g);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'wrong_device_group' });
    expect(denied.body).not.toContain(VALUE);
    const row = auditRows(w.db, 'grant.redeem_denied')[0]!;
    expect(row).toMatchObject({ device_id: other.deviceId });
    expect(JSON.parse(String(row.meta))).toMatchObject({ cause: 'wrong_group' });
    // The denial did not consume the grant.
    expect((await redeem(cli.accessToken, g)).statusCode).toBe(200);
  });

  it('unrestricted main device (no attached CLI): any CLI of the user redeems', async () => {
    const { w, grant, redeem } = await setup();
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli-2' });
    expect((await redeem(other.accessToken, grant())).statusCode).toBe(200);
  });

  it('request by an attached CLI: redeemable by itself, not by an outside CLI', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const other = device(w, w.alice, 'cli');
    link(w, cli.deviceId, mcp.deviceId);
    const g1 = grant(undefined, cli.identity);
    expect((await redeem(other.accessToken, g1)).json()).toEqual({ error: 'wrong_device_group' });
    expect((await redeem(cli.accessToken, g1)).statusCode).toBe(200);
  });

  it('the restriction is snapshotted at issue: the last CLI unlinked after issue → an outside CLI is still denied', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli-2' });
    link(w, cli.deviceId, mcp.deviceId);
    const g = grant();
    const snap = w.db.$client.prepare('SELECT restricted_to_device_id AS r FROM grants WHERE id = ?').get(g) as { r: string | null };
    expect(snap.r).toBe(mcp.deviceId);
    link(w, cli.deviceId, null); // the group dissolves (main has no attached CLI any more)
    expect((await redeem(other.accessToken, g)).json()).toEqual({ error: 'wrong_device_group' });
    // The former member is outside the group now, too.
    expect((await redeem(cli.accessToken, g)).json()).toEqual({ error: 'wrong_device_group' });
    // A CLI attached to the snapshotted main later may redeem.
    link(w, other.deviceId, mcp.deviceId);
    expect((await redeem(other.accessToken, g)).statusCode).toBe(200);
  });

  it('the last CLI revoked after issue → an outside CLI is still denied', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli-2' });
    link(w, cli.deviceId, mcp.deviceId);
    const g = grant();
    revokeDevice(w.ctx, cli.deviceId, { type: 'user', userId: w.alice.id });
    expect((await redeem(other.accessToken, g)).json()).toEqual({ error: 'wrong_device_group' });
  });

  it('issued while unrestricted, then a CLI is linked to the main: the live rule binds the grant to the new group', async () => {
    const { w, mcp, cli, grant, redeem } = await setup();
    const other = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'alice-cli-2' });
    const g = grant();
    const snap = w.db.$client.prepare('SELECT restricted_to_device_id AS r FROM grants WHERE id = ?').get(g) as { r: string | null };
    expect(snap.r).toBeNull();
    link(w, cli.deviceId, mcp.deviceId);
    // No snapshot, but the requesting main is restricted now: only its group (the newly linked CLI) may redeem.
    expect((await redeem(other.accessToken, g)).json()).toEqual({ error: 'wrong_device_group' });
    expect((await redeem(cli.accessToken, g)).statusCode).toBe(200);
  });
});

describe('CLI device API', () => {
  it('rejects mcp devices (403 forbidden_device_kind) and missing tokens (401)', async () => {
    const { w, secret, mcp } = await setup();
    const routes: [Method, string, unknown?][] = [
      ['POST', '/api/cli/requests', { secretId: secret.id, project: 'foo', reason: 'r' }],
      ['GET', '/api/cli/requests/req_x/wait'],
      ['POST', '/api/cli/secrets', { title: 't', project: 'foo', reason: 'r', generate: { length: 32 } }],
      ['POST', `/api/cli/secrets/${secret.id}/update`, { project: 'foo', reason: 'r', generate: { length: 32 } }],
      ['POST', `/api/cli/secrets/${secret.id}/archive`, { project: 'foo', reason: 'r' }],
      ['GET', '/api/cli/secrets?q=&project=foo'],
    ];
    for (const [method, url, body] of routes) {
      const res = await call(w, mcp.accessToken, method, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_device_kind' });
      expect((await call(w, undefined, method, url, body)).statusCode, url).toBe(401);
    }
  });

  it('POST /api/cli/requests creates a cli-delivery request (project normalized); wait returns grantId once approved', async () => {
    const { w, secret, cli } = await setup();
    const res = await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'Foo Bar', reason: 'deploy' });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto).toMatchObject({ status: 'pending', delivery: 'cli', project: 'foo-bar', device: { id: cli.deviceId, kind: 'cli' } });
    expect(dto).not.toHaveProperty('grantId');

    const pending = await call(w, cli.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait?timeoutMs=50`);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ id: dto.id, status: 'pending' });

    const waiting = call(w, cli.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait?timeoutMs=5000`);
    await new Promise((r) => setTimeout(r, 50));
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const done = (await waiting).json();
    expect(done).toMatchObject({ status: 'approved' });
    expect(done.grantId).toMatch(/^grt_/);
    const redeemed = await call(w, cli.accessToken, 'POST', `/api/grants/${done.grantId}/redeem`, {});
    expect(redeemed.json().secrets[0].value).toBe(VALUE);
  });

  it('request validation: project and reason required; delivery is always cli; other device → 404 on wait', async () => {
    const { w, secret, cli } = await setup();
    expect((await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, reason: 'r' })).statusCode).toBe(400);
    expect((await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p' })).statusCode).toBe(400);
    const plain = await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r', delivery: 'plaintext' });
    expect(plain.statusCode).toBe(400);
    const dto = (await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r' })).json();
    const other = device(w, w.alice, 'cli');
    expect((await call(w, other.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait?timeoutMs=10`)).statusCode).toBe(404);
  });

  it('auto mode: the created request is approved immediately and carries grantId', async () => {
    const { w, secret, cli } = await setup();
    enableAutoMode(w.ctx, w.alice.id, 30);
    const dto = (await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r' })).json();
    expect(dto.status).toBe('approved');
    expect(dto.grantId).toMatch(/^grt_/);
  });

  it('denied request: wait reports denied without grantId', async () => {
    const { w, secret, cli } = await setup();
    const dto = (await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r' })).json();
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'deny' });
    const res = (await call(w, cli.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait`)).json();
    expect(res.status).toBe('denied');
    expect(res).not.toHaveProperty('grantId');
  });

  it('a client disconnect ends the wait long-poll (no leaked waiters)', async () => {
    const { w, secret, cli } = await setup();
    await w.app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => w.app.close());
    const base = `http://127.0.0.1:${(w.app.server.address() as AddressInfo).port}`;
    const dto = (await call(w, cli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r' })).json();
    const reqs = Array.from({ length: 20 }, () =>
      request(`${base}/api/cli/requests/${dto.id}/wait`, { agent: false, headers: { authorization: `Bearer ${cli.accessToken}` } })
        .on('error', () => {})
        .end(),
    );
    await new Promise((r) => setTimeout(r, 200));
    reqs.forEach((r) => r.destroy());
    await new Promise((r) => setTimeout(r, 100));
    // 20 leaked waiters (MAX_WAITERS_PER_DEVICE) would make this fail with 429 too_many_waiters.
    const res = await call(w, cli.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait?timeoutMs=10`);
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/cli/secrets creates a secret as the device (no approval); value never echoed', async () => {
    const { w, cli } = await setup();
    const res = await call(w, cli.accessToken, 'POST', '/api/cli/secrets', {
      title: 'New', description: 'd', tags: ['a'], envName: 'NEW_TOKEN', value: 'NEW_SECRET_VALUE', project: 'My App', reason: 'setup',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ secretId: expect.stringMatching(/^sec_/), version: 1 });
    expect(res.body).not.toContain('NEW_SECRET_VALUE');
    const row = auditRows(w.db, 'secret.created').at(-1)!;
    expect(row).toMatchObject({ actor_type: 'device', device_id: cli.deviceId, project: 'my-app' });
    // Devices may never set the plaintext flag; project and reason are required.
    const flag = await call(w, cli.accessToken, 'POST', '/api/cli/secrets', {
      title: 'X', generate: { length: 32 }, project: 'p', reason: 'r', allowPlaintextToAgent: true,
    });
    expect(flag.statusCode).toBe(400);
    expect((await call(w, cli.accessToken, 'POST', '/api/cli/secrets', { title: 'X', generate: { length: 32 }, reason: 'r' })).statusCode).toBe(400);
  });

  it('POST /api/cli/secrets/:id/update creates an update request; wait returns the new version after approval', async () => {
    const { w, secret, cli } = await setup();
    const res = await call(w, cli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/update`, {
      project: 'p', reason: 'rotate', value: 'ROTATED_VALUE', title: 'GitHub Token (new)',
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto).toMatchObject({ kind: 'update', status: 'pending', valueChanged: true });
    expect(res.body).not.toContain('ROTATED_VALUE');
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const done = (await call(w, cli.accessToken, 'GET', `/api/cli/requests/${dto.id}/wait`)).json();
    expect(done).toMatchObject({ status: 'approved', version: 2 });
    expect(done).not.toHaveProperty('grantId');
    expect((await call(w, cli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/update`, { project: 'p', reason: 'r', allowPlaintextToAgent: true })).statusCode).toBe(400);
  });

  it('POST /api/cli/secrets/:id/archive archives with reason + project; search hides it unless archived=true', async () => {
    const { w, secret, cli } = await setup();
    expect((await call(w, cli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/archive`, { reason: 'gone' })).statusCode).toBe(400);
    const res = await call(w, cli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/archive`, { reason: 'replaced', project: 'Foo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: secret.id, archived: { reason: 'replaced', project: 'foo', by: { type: 'device' } } });

    const active = (await call(w, cli.accessToken, 'GET', '/api/cli/secrets?q=github&project=foo')).json();
    expect(active.items).toEqual([]);
    const all = (await call(w, cli.accessToken, 'GET', '/api/cli/secrets?q=github&project=foo&archived=true')).json();
    expect(all.items.map((s: { id: string }) => s.id)).toEqual([secret.id]);
    expect((await call(w, cli.accessToken, 'GET', '/api/cli/secrets?q=github')).statusCode).toBe(400);
  });

  it("another user's cli device: update/archive of a foreign secret → 404; createSecret into a foreign vault → 404", async () => {
    const { w, secret } = await setup();
    const bobCli = device(w, w.bob, 'cli');
    const upd = await call(w, bobCli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/update`, { project: 'p', reason: 'r', generate: { length: 32 } });
    expect(upd.statusCode).toBe(404);
    const arch = await call(w, bobCli.accessToken, 'POST', `/api/cli/secrets/${secret.id}/archive`, { project: 'p', reason: 'r' });
    expect(arch.statusCode).toBe(404);
    expect(w.db.$client.prepare('SELECT archived_at FROM secrets WHERE id = ?').get(secret.id)).toEqual({ archived_at: null });
    expect(w.db.$client.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE kind = 'update'").get()).toEqual({ n: 0 });
    const req = await call(w, bobCli.accessToken, 'POST', '/api/cli/requests', { secretId: secret.id, project: 'p', reason: 'r' });
    expect(req.statusCode).toBe(404);
    const created = await call(w, bobCli.accessToken, 'POST', '/api/cli/secrets', {
      title: 'Planted', vaultId: secret.vaultId, generate: { length: 32 }, project: 'p', reason: 'r',
    });
    expect(created.statusCode).toBe(404);
    expect(w.db.$client.prepare('SELECT COUNT(*) AS n FROM secrets WHERE vault_id = ?').get(secret.vaultId)).toEqual({ n: 1 });
  });

  it("search is scoped to the device owner's vaults and audited", async () => {
    const { w, secret, cli } = await setup();
    const bobCli = device(w, w.bob, 'cli');
    const mine = (await call(w, cli.accessToken, 'GET', '/api/cli/secrets?q=&project=foo')).json();
    expect(mine.items.map((s: { id: string }) => s.id)).toEqual([secret.id]);
    expect(JSON.stringify(mine)).not.toContain(VALUE);
    const bobs = (await call(w, bobCli.accessToken, 'GET', '/api/cli/secrets?q=&project=foo')).json();
    expect(bobs.items).toEqual([]);
    expect(auditRows(w.db, 'secret.searched').at(-1)).toMatchObject({ device_id: bobCli.deviceId, project: 'foo' });
  });
});

describe('shared api client against the server', () => {
  it('device login, request, wait, redeem, create, update, archive, search', async () => {
    const { w, secret } = await setup();
    await w.app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => w.app.close());
    const base = `http://127.0.0.1:${(w.app.server.address() as AddressInfo).port}`;
    let tokens: { access: string; refresh: string } | undefined;
    const api = createApiClient({
      baseUrl: base,
      getAccessToken: () => tokens?.access,
      onUnauthorized: async () => {
        const t = await api.token({ grant_type: 'refresh_token', refresh_token: tokens!.refresh });
        tokens = { access: t.access_token, refresh: t.refresh_token };
        return true;
      },
    });

    const da = await api.deviceAuthorization({ client_name: 'asm-cli', hostname: 'box' });
    await expect(api.token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.device_code })).rejects.toMatchObject({
      status: 400, code: 'authorization_pending',
    });
    const act = await w.req(w.alice, 'POST', '/api/devices/activate', { user_code: da.user_code, decision: 'approve' });
    expect(act.statusCode).toBe(200);
    w.clock.advance(5_000);
    const t = await api.token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.device_code });
    tokens = { access: t.access_token, refresh: 'invalid' };

    const dto = await api.createRequest({ secretId: secret.id, project: 'p', reason: 'deploy' });
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const done = await api.waitRequest(dto.id, { timeoutMs: 1000 });
    expect(done.status).toBe('approved');
    expect(await api.redeemGrant(done.grantId!, 'box')).toEqual({ secrets: [{ secretId: secret.id, envName: 'GITHUB_TOKEN', value: VALUE }] });
    await expect(api.redeemGrant(done.grantId!)).rejects.toBeInstanceOf(ApiError);

    const created = await api.createSecret({ title: 'New', description: '', generate: { length: 32 }, project: 'p', reason: 'r' });
    expect(created.version).toBe(1);
    const upd = await api.updateSecret(created.secretId, { project: 'p', reason: 'r', envName: 'NEW_ONE' });
    expect(upd).toMatchObject({ kind: 'update', status: 'pending' });
    const arch = await api.archiveSecret(created.secretId, { reason: 'gone', project: 'p' });
    expect(arch.archived?.reason).toBe('gone');
    expect((await api.searchSecrets({ q: '', project: 'p', archived: true })).items.map((s) => s.id).sort()).toEqual([created.secretId, secret.id].sort());

    // Expired access token: the client refreshes once (here: invalid refresh token → invalid_grant surfaces).
    w.clock.advance(2 * 3600_000);
    await expect(api.searchSecrets({ q: '', project: 'p' })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});
