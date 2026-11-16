import { describe, expect, it } from 'vitest';
import { AccessRequestDtoSchema } from '@asm/shared';
import { verifyChain } from '../src/audit/audit.js';
import { HttpError, ValidationError } from '../src/errors.js';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import { enableAutoMode } from '../src/requests/automode.js';
import { grantIdForRequest, redeemGrant } from '../src/requests/grants.js';
import {
  cancelOpenForSecret,
  createRequest,
  createUpdateRequest,
  decideRequest,
  expireDue,
  waitForRequest,
} from '../src/requests/service.js';
import { applySecretChange, archiveSecret, createSecret, getSecretMeta, openVersion } from '../src/secrets/service.js';
import { listVersions } from '../src/secrets/versions.js';
import { addMember, createVault, removeMember } from '../src/vaults/service.js';
import { revokeDevice } from '../src/devices/service.js';
import { FORBIDDEN_RESPONSE_KEYS, allKeys, auditRows, pairDevice, world, type TestUser } from './helpers/fixtures.js';

const MIN = 60_000;

async function rejects(p: unknown, status: number, code?: string) {
  let err: unknown;
  try {
    await (typeof p === 'function' ? (p as () => unknown)() : p);
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an error').toBeDefined();
  const s = err instanceof HttpError ? err.statusCode : err instanceof ValidationError || (err as Error).name === 'ZodError' ? 400 : 500;
  expect(s, String(err)).toBe(status);
  if (code) expect((err as { code?: string }).code).toBe(code);
}

type W = Awaited<ReturnType<typeof world>>;

function device(w: W, user: TestUser, kind: 'mcp' | 'cli' = 'mcp'): DeviceIdentity {
  const name = `${user.username}-${kind}`;
  const { deviceId } = pairDevice(w.ctx, { userId: user.id, kind, name });
  return { id: deviceId, userId: user.id, kind, name };
}

async function setup(opts: { plaintext?: boolean } = {}) {
  const w = await world();
  const secret = createSecret(w.ctx, w.alice.actor, {
    title: 'Stripe Key', envName: 'STRIPE_KEY', value: 'sk_live_TOPSECRET', allowPlaintextToAgent: opts.plaintext ?? false,
  });
  const mcp = device(w, w.alice, 'mcp');
  const cli = device(w, w.alice, 'cli');
  const read = (delivery: 'cli' | 'plaintext' = 'cli', d = mcp) =>
    createRequest(w.ctx, { device: d, secretId: secret.id, project: 'My App', reason: 'deploy', delivery });
  return { w, secret, mcp, cli, read };
}

describe('requests: read', () => {
  it('requires project and reason (400)', async () => {
    const { w, secret, mcp } = await setup();
    for (const bad of [{ project: '', reason: 'x' }, { project: 'p', reason: '' }, { reason: 'x' }, { project: 'p' }, { project: 'p'.repeat(201), reason: 'x' }]) {
      await rejects(() => createRequest(w.ctx, { device: mcp, secretId: secret.id, delivery: 'cli', ...bad } as never), 400);
    }
  });

  it('inaccessible secret -> 404; archived -> 409 secret_archived', async () => {
    const { w, secret } = await setup();
    const bobDev = device(w, w.bob);
    await rejects(() => createRequest(w.ctx, { device: bobDev, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' }), 404);
    archiveSecret(w.ctx, w.alice.actor, secret.id, { reason: 'old' });
    const mcp = device(w, w.alice);
    await rejects(() => createRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' }), 409, 'secret_archived');
  });

  it('delivery plaintext without flag -> 403 plaintext_not_allowed', async () => {
    const { read } = await setup();
    await rejects(() => read('plaintext'), 403, 'plaintext_not_allowed');
  });

  it('creates a pending request (5 min), audits request.created, touches project', async () => {
    const { w, secret, mcp, read } = await setup();
    const dto = read();
    AccessRequestDtoSchema.parse(dto);
    expect(dto).toMatchObject({
      kind: 'read', status: 'pending', auto: false, project: 'my-app', reason: 'deploy', delivery: 'cli',
      secret: { id: secret.id, title: 'Stripe Key', envName: 'STRIPE_KEY' }, device: { id: mcp.id, name: 'alice-mcp', kind: 'mcp' },
      expiresAt: w.clock.now() + 5 * MIN, decidedBy: null,
    });
    expect(auditRows(w.db, 'request.created')[0]).toMatchObject({ actor_type: 'device', device_id: mcp.id, secret_id: secret.id, vault_id: secret.vaultId, project: 'my-app' });
    expect(w.db.$client.prepare('SELECT slug FROM projects').all()).toEqual([{ slug: 'my-app' }]);
  });

  it('foreign user cannot decide (403); owner approves -> grant 15 min, request.approved, usage recorded', async () => {
    const { w, secret, mcp, read } = await setup();
    const dto = read();
    await rejects(() => decideRequest(w.ctx, { requestId: dto.id, userId: w.bob.id, decision: 'approve' }), 403);
    const res = await w.req(w.bob, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'approve' });
    expect(res.statusCode).toBe(403);

    const ok = await w.req(w.alice, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', auto: false, decidedBy: { type: 'user', id: w.alice.id, name: 'alice' } });
    const grants = w.db.$client.prepare('SELECT * FROM grants').all() as { id: string; uses_left: number; expires_at: number; request_id: string }[];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ uses_left: 1, expires_at: w.clock.now() + 15 * MIN, request_id: dto.id });
    expect(grantIdForRequest(w.db, dto.id, mcp.id)).toBe(grants[0]!.id);
    expect(grantIdForRequest(w.db, dto.id, 'dev_other')).toBeNull();
    expect(auditRows(w.db, 'request.approved')[0]).toMatchObject({ actor_type: 'user', actor_id: w.alice.id, vault_id: secret.vaultId, device_id: mcp.id });
    expect(w.db.$client.prepare('SELECT * FROM project_usage').all()).toMatchObject([{ secret_id: secret.id, device_id: mcp.id }]);
  });

  it('two parallel decisions (approve + deny) -> exactly one succeeds, the other 409, exactly one grant', async () => {
    const { w, read } = await setup();
    const dto = read();
    const [a, b] = await Promise.all([
      w.req(w.alice, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'approve' }),
      w.req(w.alice, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'deny' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json()).toEqual({ error: 'already_decided' });
    const status = (w.db.$client.prepare('SELECT status FROM access_requests').get() as { status: string }).status;
    const grantCount = (w.db.$client.prepare('SELECT count(*) AS n FROM grants').get() as { n: number }).n;
    expect(grantCount).toBe(status === 'approved' ? 1 : 0);
    // Service level: second decision always 409.
    const dto2 = read();
    decideRequest(w.ctx, { requestId: dto2.id, userId: w.alice.id, decision: 'approve' });
    await rejects(() => decideRequest(w.ctx, { requestId: dto2.id, userId: w.alice.id, decision: 'deny' }), 409, 'already_decided');
    expect((w.db.$client.prepare('SELECT count(*) AS n FROM grants WHERE request_id = ?').get(dto2.id) as { n: number }).n).toBe(1);
  });

  it('owner loses vault membership after request -> approval 403 (and request denied by hook)', async () => {
    const w = await world();
    const vault = createVault(w.ctx, w.alice.id, 'Team');
    addMember(w.ctx, w.alice.id, vault.id, { username: 'bob' });
    const s = createSecret(w.ctx, w.alice.actor, { vaultId: vault.id, title: 'Shared', value: 'v1' });
    const bobDev = device(w, w.bob);
    const r1 = createRequest(w.ctx, { device: bobDev, secretId: s.id, project: 'p', reason: 'r', delivery: 'cli' });
    // Direct membership loss without the hook (e.g. raw delete): decision still re-checks access.
    w.db.$client.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vault.id, w.bob.id);
    await rejects(() => decideRequest(w.ctx, { requestId: r1.id, userId: w.bob.id, decision: 'approve' }), 403, 'forbidden');
    expect((w.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(r1.id) as { status: string }).status).toBe('pending');

    // Via removeMember: hook denies pending requests (cause member_removed) and deletes grants.
    addMember(w.ctx, w.alice.id, vault.id, { username: 'bob' });
    const r2 = createRequest(w.ctx, { device: bobDev, secretId: s.id, project: 'p', reason: 'r', delivery: 'cli' });
    const r3 = createRequest(w.ctx, { device: bobDev, secretId: s.id, project: 'p', reason: 'r', delivery: 'cli' });
    decideRequest(w.ctx, { requestId: r3.id, userId: w.bob.id, decision: 'approve' });
    removeMember(w.ctx, w.alice.id, vault.id, w.bob.id);
    const row = w.db.$client.prepare('SELECT status, decided_by FROM access_requests WHERE id = ?').get(r2.id);
    expect(row).toEqual({ status: 'denied', decided_by: 'system' });
    expect(w.db.$client.prepare('SELECT * FROM grants').all()).toEqual([]);
    const denied = auditRows(w.db, 'request.denied').find((a) => String(a.meta).includes('member_removed'));
    expect(denied).toMatchObject({ actor_type: 'system', secret_id: s.id, vault_id: vault.id });
    await rejects(() => decideRequest(w.ctx, { requestId: r2.id, userId: w.bob.id, decision: 'approve' }), 403);
  });

  it('after 5 min expireDue -> expired + audit; decide -> 410 expired', async () => {
    const { w, secret, read } = await setup();
    const dto = read();
    w.clock.advance(5 * MIN - 1);
    expireDue(w.ctx);
    expect((w.db.$client.prepare('SELECT status FROM access_requests').get() as { status: string }).status).toBe('pending');
    w.clock.advance(1);
    // Expired but not yet swept: decision already 410.
    await rejects(() => decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' }), 410, 'expired');
    expireDue(w.ctx);
    expect((w.db.$client.prepare('SELECT status FROM access_requests').get() as { status: string }).status).toBe('expired');
    expect(auditRows(w.db, 'request.expired')[0]).toMatchObject({ actor_type: 'system', secret_id: secret.id, vault_id: secret.vaultId });
    await rejects(() => decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' }), 410, 'expired');
    expect(verifyChain(w.db)).toEqual({ ok: true });
  });

  it('requesting device revoked -> approval 409 device_inactive and request denied', async () => {
    const { w, mcp, read } = await setup();
    const dto = read();
    w.db.$client.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(mcp.id);
    await rejects(() => decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' }), 409, 'device_inactive');
    expect(w.db.$client.prepare('SELECT status, decided_by FROM access_requests').get()).toEqual({ status: 'denied', decided_by: 'system' });
    expect(w.db.$client.prepare('SELECT * FROM grants').all()).toEqual([]);
  });

  it('GET /api/requests lists own requests newest first; pending filter; never values', async () => {
    const { w, read } = await setup({ plaintext: true });
    const a = read();
    w.clock.advance(1000);
    const b = read('plaintext');
    decideRequest(w.ctx, { requestId: a.id, userId: w.alice.id, decision: 'deny' });
    const pending = (await w.req(w.alice, 'GET', '/api/requests')).json().items as { id: string }[];
    expect(pending.map((r) => r.id)).toEqual([b.id]);
    const all = (await w.req(w.alice, 'GET', '/api/requests?status=all')).json().items as { id: string }[];
    expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
    expect((await w.req(w.bob, 'GET', '/api/requests?status=all')).json().items).toEqual([]);
    expect((await w.req(undefined, 'GET', '/api/requests')).statusCode).toBe(401);
    expect((await w.req(w.alice, 'POST', `/api/requests/${b.id}/decision`, { decision: 'maybe' })).statusCode).toBe(400);
  });
});

describe('grants: redemption', () => {
  it('cli grant: redeemable once by a cli device of the owner; audit grant.redeemed; then 410', async () => {
    const { w, secret, mcp, cli, read } = await setup();
    const dto = read('cli');
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const grantId = grantIdForRequest(w.db, dto.id, mcp.id)!;
    await rejects(() => redeemGrant(w.ctx, { grantId, device: mcp }, {}), 403, 'forbidden');
    const bobCli = device(w, w.bob, 'cli');
    await rejects(() => redeemGrant(w.ctx, { grantId, device: bobCli }, {}), 403, 'forbidden');
    const out = redeemGrant(w.ctx, { grantId, device: cli }, { hostname: 'box' });
    expect(out).toEqual({ secretId: secret.id, envName: 'STRIPE_KEY', value: 'sk_live_TOPSECRET', delivery: 'cli' });
    expect(auditRows(w.db, 'grant.redeemed')[0]).toMatchObject({ actor_type: 'device', device_id: cli.id, secret_id: secret.id, vault_id: secret.vaultId });
    expect(String(auditRows(w.db, 'grant.redeemed')[0]!.meta)).toContain('box');
    await rejects(() => redeemGrant(w.ctx, { grantId, device: cli }, {}), 410, 'grant_gone');
    expect(auditRows(w.db, 'grant.redeem_denied').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain('sk_live_TOPSECRET');
  });

  it('plaintext grant: only the requesting device; audit secret.plaintext_delivered', async () => {
    const { w, mcp, cli, read } = await setup({ plaintext: true });
    const dto = read('plaintext');
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const grantId = grantIdForRequest(w.db, dto.id, mcp.id)!;
    await rejects(() => redeemGrant(w.ctx, { grantId, device: cli }, {}), 403);
    expect(redeemGrant(w.ctx, { grantId, device: mcp }, {}).value).toBe('sk_live_TOPSECRET');
    expect(auditRows(w.db, 'secret.plaintext_delivered')).toHaveLength(1);
    expect(auditRows(w.db, 'grant.redeemed')).toHaveLength(0);
  });

  it('expired grant (15 min) -> 410; unknown grant -> 410', async () => {
    const { w, mcp, cli, read } = await setup();
    const dto = read();
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    const grantId = grantIdForRequest(w.db, dto.id, mcp.id)!;
    w.clock.advance(15 * MIN);
    await rejects(() => redeemGrant(w.ctx, { grantId, device: cli }, {}), 410, 'grant_gone');
    const before = auditRows(w.db, 'grant.redeem_denied').length;
    await rejects(() => redeemGrant(w.ctx, { grantId: 'grt_nope', device: cli }, {}), 404, 'grant_not_found');
    expect(auditRows(w.db, 'grant.redeem_denied')).toHaveLength(before);
    await rejects(() => redeemGrant(w.ctx, { grantId: 'grt_01ARZ3NDEKTSV4RRFFQ69G5FAV', device: cli }, {}), 410, 'grant_gone');
  });

  it('expireDue deletes expired and used-up grants', async () => {
    const { w, mcp, cli, read } = await setup();
    const a = read();
    decideRequest(w.ctx, { requestId: a.id, userId: w.alice.id, decision: 'approve' });
    redeemGrant(w.ctx, { grantId: grantIdForRequest(w.db, a.id, mcp.id)!, device: cli }, {});
    const b = read();
    decideRequest(w.ctx, { requestId: b.id, userId: w.alice.id, decision: 'approve' });
    w.clock.advance(1000);
    const c = read();
    decideRequest(w.ctx, { requestId: c.id, userId: w.alice.id, decision: 'approve' });
    w.clock.advance(15 * MIN - 500);
    expireDue(w.ctx);
    expect((w.db.$client.prepare('SELECT request_id FROM grants').all() as { request_id: string }[]).map((g) => g.request_id)).toEqual([c.id]);
  });

  it('requesting device revoked -> its grants unusable (403) and deleted by revokeDevice', async () => {
    const { w, mcp, cli, read } = await setup();
    const a = read();
    decideRequest(w.ctx, { requestId: a.id, userId: w.alice.id, decision: 'approve' });
    const ga = grantIdForRequest(w.db, a.id, mcp.id)!;
    w.db.$client.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").run(mcp.id);
    await rejects(() => redeemGrant(w.ctx, { grantId: ga, device: cli }, {}), 403, 'forbidden');
    const denied = auditRows(w.db, 'grant.redeem_denied').at(-1)!;
    expect(JSON.parse(String(denied.meta))).toMatchObject({ cause: 'device_inactive' });

    w.db.$client.prepare("UPDATE devices SET status = 'approved' WHERE id = ?").run(mcp.id);
    revokeDevice(w.ctx, mcp.id, { type: 'user', userId: w.alice.id });
    expect(w.db.$client.prepare('SELECT * FROM grants').all()).toEqual([]);
    await rejects(() => redeemGrant(w.ctx, { grantId: ga, device: cli }, {}), 410, 'grant_gone');
  });

  it('lost vault access -> 403 forbidden; archived secret -> 409 secret_archived', async () => {
    const w = await world();
    const vault = createVault(w.ctx, w.alice.id, 'Team');
    addMember(w.ctx, w.alice.id, vault.id, { username: 'bob' });
    const s = createSecret(w.ctx, w.alice.actor, { vaultId: vault.id, title: 'Shared', value: 'v1' });
    const bobMcp = device(w, w.bob);
    const bobCli = device(w, w.bob, 'cli');
    const r = createRequest(w.ctx, { device: bobMcp, secretId: s.id, project: 'p', reason: 'r', delivery: 'cli' });
    decideRequest(w.ctx, { requestId: r.id, userId: w.bob.id, decision: 'approve' });
    const grantId = grantIdForRequest(w.db, r.id, bobMcp.id)!;
    w.db.$client.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vault.id, w.bob.id);
    await rejects(() => redeemGrant(w.ctx, { grantId, device: bobCli }, {}), 403, 'forbidden');

    const aliceMcp = device(w, w.alice);
    const aliceCli = device(w, w.alice, 'cli');
    const r2 = createRequest(w.ctx, { device: aliceMcp, secretId: s.id, project: 'p', reason: 'r', delivery: 'cli' });
    decideRequest(w.ctx, { requestId: r2.id, userId: w.alice.id, decision: 'approve' });
    const g2 = grantIdForRequest(w.db, r2.id, aliceMcp.id)!;
    // Simulate an archive that bypassed the hook: redemption still checks.
    w.db.$client.prepare('UPDATE secrets SET archived_at = 1 WHERE id = ?').run(s.id);
    await rejects(() => redeemGrant(w.ctx, { grantId: g2, device: aliceCli }, {}), 409, 'secret_archived');
  });
});

describe('requests: archive cancels', () => {
  it('archiving with open read + update request -> both denied (cause archived), waitForRequest resolves, grant gone', async () => {
    const { w, secret, mcp, cli, read } = await setup();
    const approved = read();
    decideRequest(w.ctx, { requestId: approved.id, userId: w.alice.id, decision: 'approve' });
    const grantId = grantIdForRequest(w.db, approved.id, mcp.id)!;
    const r = read();
    const u = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'rotate', value: 'new-val' });
    const waiting = waitForRequest(w.ctx, r.id, mcp.id, 5_000);
    archiveSecret(w.ctx, w.alice.actor, secret.id, { reason: 'gone' });
    const done = await waiting;
    expect(done.status).toBe('denied');
    expect(done.decidedBy).toEqual({ type: 'system', id: null, name: null });
    const rows = w.db.$client.prepare('SELECT id, status, decided_by, proposed_value_sealed FROM access_requests WHERE id IN (?, ?)').all(r.id, u.id);
    expect(rows).toEqual([
      expect.objectContaining({ status: 'denied', decided_by: 'system', proposed_value_sealed: null }),
      expect.objectContaining({ status: 'denied', decided_by: 'system', proposed_value_sealed: null }),
    ]);
    const denied = auditRows(w.db, 'request.denied');
    expect(denied).toHaveLength(2);
    for (const a of denied) {
      expect(a).toMatchObject({ actor_type: 'system', secret_id: secret.id, vault_id: secret.vaultId });
      expect(JSON.parse(String(a.meta))).toMatchObject({ cause: 'archived' });
    }
    await rejects(() => redeemGrant(w.ctx, { grantId, device: cli }, {}), 410);
    // Direct call is idempotent.
    cancelOpenForSecret(w.ctx, secret.id);
    expect(auditRows(w.db, 'request.denied')).toHaveLength(2);
  });
});

describe('requests: update', () => {
  it('allowPlaintextToAgent in meta -> 400 field_not_allowed; no changes -> 400', async () => {
    const { w, secret, mcp } = await setup();
    await rejects(() => createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', meta: { allowPlaintextToAgent: true } as never }), 400, 'field_not_allowed');
    await rejects(() => createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', meta: { title: 'Stripe Key' } }), 400, 'no_changes');
    await rejects(() => createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', value: 'a', generate: { length: 32 } }), 400);
    await rejects(() => createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: '', reason: 'r', value: 'a' }), 400);
  });

  it('pending keeps current_version; approve -> new version by device with project/reason; DTO never has value', async () => {
    const { w, secret, mcp } = await setup();
    const dto = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'My App', reason: 'rotate', meta: { title: 'Stripe Live' }, value: 'sk_NEW_VALUE' });
    AccessRequestDtoSchema.parse(dto);
    expect(dto).toMatchObject({ kind: 'update', status: 'pending', delivery: null, valueChanged: true, metaDiff: { title: { from: 'Stripe Key', to: 'Stripe Live' } } });
    const sealed = w.db.$client.prepare('SELECT proposed_value_sealed AS s FROM access_requests').get() as { s: string };
    expect(sealed.s).not.toContain('sk_NEW_VALUE');
    expect(getSecretMeta(w.db, w.alice.id, secret.id).title).toBe('Stripe Key');
    expect(listVersions(w.db, w.alice.id, secret.id)).toHaveLength(1);

    const res = await w.req(w.alice, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('sk_NEW_VALUE');
    for (const k of FORBIDDEN_RESPONSE_KEYS) expect(allKeys(res.json()).has(k)).toBe(false);
    expect(getSecretMeta(w.db, w.alice.id, secret.id).title).toBe('Stripe Live');
    expect(openVersion(w.ctx, secret.id, 2).plaintext).toBe('sk_NEW_VALUE');
    const v2 = w.db.$client.prepare('SELECT changed_by_type, changed_by_id, project, reason FROM secret_versions WHERE version = 2').get();
    expect(v2).toEqual({ changed_by_type: 'device', changed_by_id: mcp.id, project: 'my-app', reason: 'rotate' });
    expect(w.db.$client.prepare('SELECT proposed_value_sealed AS s FROM access_requests').get()).toEqual({ s: null });
    expect(w.db.$client.prepare('SELECT * FROM grants').all()).toEqual([]);
    const list = (await w.req(w.alice, 'GET', '/api/requests?status=all')).json();
    expect(JSON.stringify(list)).not.toContain('sk_NEW_VALUE');
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain('sk_NEW_VALUE');
  });

  it('deny -> no new version and proposed value deleted; generate is sealed server-side', async () => {
    const { w, secret, mcp } = await setup();
    const dto = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'rotate', generate: { length: 32, alphabet: 'hex' } });
    expect(dto.valueChanged).toBe(true);
    expect(w.db.$client.prepare('SELECT proposed_value_sealed AS s FROM access_requests').get()).not.toEqual({ s: null });
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'deny' });
    expect(listVersions(w.db, w.alice.id, secret.id)).toHaveLength(1);
    expect(w.db.$client.prepare('SELECT status, proposed_value_sealed AS s FROM access_requests').get()).toEqual({ status: 'denied', s: null });
  });

  it('stale proposal (secret changed since request) -> 409 apply_failed {cause: stale}, denied by approver, value cleared, event', async () => {
    const { w, secret, mcp } = await setup();
    const dto = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', meta: { title: 'Renamed' } });
    // A human changes the secret first (version 2): the proposal is based on version 1.
    applySecretChange(w.ctx, w.alice.actor, secret.id, { meta: { description: 'edited' } });
    const events: unknown[] = [];
    w.ctx.events.subscribe(w.alice.id, (e) => events.push(e));
    const res = await w.req(w.alice, 'POST', `/api/requests/${dto.id}/decision`, { decision: 'approve' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'apply_failed', cause: 'stale' });
    expect(w.db.$client.prepare('SELECT status, decided_by, proposed_value_sealed AS s FROM access_requests').get()).toEqual({
      status: 'denied', decided_by: w.alice.id, s: null,
    });
    expect(listVersions(w.db, w.alice.id, secret.id)).toHaveLength(2);
    const denied = auditRows(w.db, 'request.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_type: 'user', actor_id: w.alice.id, vault_id: secret.vaultId, secret_id: secret.id });
    expect(JSON.parse(String(denied[0]!.meta))).toMatchObject({ cause: 'apply_failed', error: 'stale' });
    expect(auditRows(w.db, 'request.approved')).toHaveLength(0);
    expect(getSecretMeta(w.db, w.alice.id, secret.id).title).toBe('Stripe Key');
    expect(events).toEqual([{ type: 'request.updated', data: expect.objectContaining({ id: dto.id, status: 'denied' }) }]);

    // With a value proposal and an archived secret (hook bypassed): cause secret_archived, value cleared.
    const d2 = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', value: 'new-v' });
    w.db.$client.prepare('UPDATE secrets SET archived_at = 1 WHERE id = ?').run(secret.id);
    await rejects(() => decideRequest(w.ctx, { requestId: d2.id, userId: w.alice.id, decision: 'approve' }), 409, 'apply_failed');
    expect(w.db.$client.prepare('SELECT status, proposed_value_sealed AS s FROM access_requests WHERE id = ?').get(d2.id)).toEqual({ status: 'denied', s: null });
  });

  it('meta-only update applies the metadata and keeps the value', async () => {
    const { w, secret, mcp } = await setup();
    const dto = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', meta: { envName: null, tags: ['prod'] } });
    expect(dto.valueChanged).toBe(false);
    expect(dto.metaDiff).toEqual({ envName: { from: 'STRIPE_KEY', to: null }, tags: { from: [], to: ['prod'] } });
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' });
    expect(getSecretMeta(w.db, w.alice.id, secret.id)).toMatchObject({ envName: null, tags: ['prod'] });
    expect(openVersion(w.ctx, secret.id, 2).plaintext).toBe('sk_live_TOPSECRET');
  });

  it('auto mode applies update immediately', async () => {
    const { w, secret, mcp } = await setup();
    enableAutoMode(w.ctx, w.alice.id, 30);
    const dto = createUpdateRequest(w.ctx, { device: mcp, secretId: secret.id, project: 'p', reason: 'r', value: 'auto-new' });
    expect(dto).toMatchObject({ status: 'approved', auto: true, decidedBy: null });
    expect(openVersion(w.ctx, secret.id, 2).plaintext).toBe('auto-new');
    expect(w.db.$client.prepare('SELECT proposed_value_sealed AS s FROM access_requests').get()).toEqual({ s: null });
    expect(auditRows(w.db, 'request.auto_approved')[0]).toMatchObject({ actor_type: 'system', vault_id: secret.vaultId, secret_id: secret.id, device_id: mcp.id });
  });
});

describe('requests: plaintext flag', () => {
  it('flag 1 -> 0: open plaintext requests denied (cause plaintext_disabled), plaintext grants deleted, cli untouched', async () => {
    const { w, secret, mcp, cli, read } = await setup({ plaintext: true });
    const issued = read('plaintext');
    decideRequest(w.ctx, { requestId: issued.id, userId: w.alice.id, decision: 'approve' });
    const pg = grantIdForRequest(w.db, issued.id, mcp.id)!;
    const cliReq = read('cli');
    decideRequest(w.ctx, { requestId: cliReq.id, userId: w.alice.id, decision: 'approve' });
    const cg = grantIdForRequest(w.db, cliReq.id, mcp.id)!;
    const open = read('plaintext');
    const openCli = read('cli');
    applySecretChange(w.ctx, w.alice.actor, secret.id, { meta: { allowPlaintextToAgent: false } });
    expect(w.db.$client.prepare('SELECT status, decided_by FROM access_requests WHERE id = ?').get(open.id)).toEqual({ status: 'denied', decided_by: 'system' });
    expect(w.db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(openCli.id)).toEqual({ status: 'pending' });
    const denied = auditRows(w.db, 'request.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_type: 'system', vault_id: secret.vaultId, secret_id: secret.id });
    expect(JSON.parse(String(denied[0]!.meta))).toMatchObject({ cause: 'plaintext_disabled' });
    await rejects(() => redeemGrant(w.ctx, { grantId: pg, device: mcp }, {}), 410);
    expect(redeemGrant(w.ctx, { grantId: cg, device: cli }, {}).value).toBe('sk_live_TOPSECRET');
  });

  it('flag off without the hook: approval 403 plaintext_not_allowed + system deny; redemption 403 (audit plaintext_disabled)', async () => {
    const { w, secret, mcp, read } = await setup({ plaintext: true });
    const issued = read('plaintext');
    decideRequest(w.ctx, { requestId: issued.id, userId: w.alice.id, decision: 'approve' });
    const pg = grantIdForRequest(w.db, issued.id, mcp.id)!;
    const pending = read('plaintext');
    w.db.$client.prepare('UPDATE secrets SET allow_plaintext_to_agent = 0 WHERE id = ?').run(secret.id);
    await rejects(() => decideRequest(w.ctx, { requestId: pending.id, userId: w.alice.id, decision: 'approve' }), 403, 'plaintext_not_allowed');
    expect(w.db.$client.prepare('SELECT status, decided_by FROM access_requests WHERE id = ?').get(pending.id)).toEqual({ status: 'denied', decided_by: 'system' });
    expect(grantIdForRequest(w.db, pending.id, mcp.id)).toBeNull();
    await rejects(() => redeemGrant(w.ctx, { grantId: pg, device: mcp }, {}), 403, 'plaintext_not_allowed');
    expect(JSON.parse(String(auditRows(w.db, 'grant.redeem_denied').at(-1)!.meta))).toMatchObject({ cause: 'plaintext_disabled' });
    expect(auditRows(w.db, 'secret.plaintext_delivered')).toHaveLength(0);
  });
});

describe('requests: waitForRequest', () => {
  it('AbortSignal cleans up and rejects with AbortError; max 20 waiters per device -> 429', async () => {
    const { w, mcp, read } = await setup();
    const dto = read();
    const ac = new AbortController();
    const p = waitForRequest(w.ctx, dto.id, mcp.id, 10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const pre = new AbortController();
    pre.abort();
    await expect(waitForRequest(w.ctx, dto.id, mcp.id, 10_000, pre.signal)).rejects.toMatchObject({ name: 'AbortError' });

    const acs = Array.from({ length: 20 }, () => new AbortController());
    const ps = acs.map((a) => waitForRequest(w.ctx, dto.id, mcp.id, 10_000, a.signal));
    await rejects(() => waitForRequest(w.ctx, dto.id, mcp.id, 10, undefined), 429, 'too_many_waiters');
    decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'deny' });
    expect((await Promise.all(ps)).every((r) => r.status === 'denied')).toBe(true);
    // Slots are released after settling.
    expect((await waitForRequest(w.ctx, dto.id, mcp.id, 10)).status).toBe('denied');
  });

  it('resolves right after decideRequest; immediately if already decided; timeout returns pending; foreign device 404', async () => {
    const { w, mcp, cli, read } = await setup();
    const dto = read();
    const started = Date.now();
    const p = waitForRequest(w.ctx, dto.id, mcp.id, 10_000);
    setTimeout(() => decideRequest(w.ctx, { requestId: dto.id, userId: w.alice.id, decision: 'approve' }), 10);
    expect((await p).status).toBe('approved');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await waitForRequest(w.ctx, dto.id, mcp.id, 10_000)).status).toBe('approved');
    const r2 = read();
    expect((await waitForRequest(w.ctx, r2.id, mcp.id, 20)).status).toBe('pending');
    await rejects(() => waitForRequest(w.ctx, r2.id, cli.id, 20), 404);
    await rejects(() => waitForRequest(w.ctx, 'req_nope', mcp.id, 20), 404);
  });
});
