import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ActivationInfoSchema, DeviceDtoSchema, StandingApprovalInputSchema } from '@asm/shared';
import type { RequestEvent } from '../src/requests/events.js';
import { disableUser } from '../src/auth/admin.js';
import { devices } from '../src/db/schema.js';
import { linkDevice, revokeDevice, setDeviceDefaultVault, unlinkDevice } from '../src/devices/service.js';
import { setStandingApproval } from '../src/standing/service.js';
import { createVault } from '../src/vaults/service.js';
import { auditRows, login, pairDevice, world } from './helpers/fixtures.js';

const DAY = 86_400_000;
const meta = (row: Record<string, unknown> | undefined) => JSON.parse(String(row?.meta ?? 'null')) as Record<string, unknown> | null;

async function setup() {
  const w = await world();
  const pair = (kind: 'mcp' | 'cli', name?: string, userId = w.alice.id) => pairDevice(w.ctx, { userId, kind, name }).deviceId;
  const main = pair('mcp', 'main');
  const main2 = pair('mcp', 'main-2');
  const cli = pair('cli', 'cli');
  const events: RequestEvent[] = [];
  w.ctx.events.subscribe(w.alice.id, (e) => events.push(e));
  const changed = () => events.filter((e) => (e.type as string) === 'device.changed').map((e) => (e.data as { deviceId: string }).deviceId);
  const row = (id: string) =>
    w.db.select({ status: devices.status, linkedTo: devices.linkedToDeviceId, defaultVaultId: devices.defaultVaultId })
      .from(devices).where(eq(devices.id, id)).get()!;
  const setStatus = (id: string, status: 'pending' | 'revoked' | 'denied') => w.db.update(devices).set({ status }).where(eq(devices.id, id)).run();
  const put = (cliId: string, mainDeviceId: string, user = w.alice) => w.req(user, 'PUT', `/api/devices/${cliId}/link`, { mainDeviceId });
  const del = (cliId: string, user = w.alice) => w.req(user, 'DELETE', `/api/devices/${cliId}/link`);
  return { ...w, pair, main, main2, cli, events, changed, row, setStatus, put, del };
}

describe('linking a CLI to a main device', () => {
  it('links via PUT, returns linkedTo, audits device.linked, emits for CLI and main', async () => {
    const s = await setup();
    const res = await s.put(s.cli, s.main);
    expect(res.statusCode).toBe(200);
    expect(DeviceDtoSchema.parse(res.json())).toMatchObject({ id: s.cli, linkedTo: { id: s.main, name: 'main' } });
    expect(s.row(s.cli).linkedTo).toBe(s.main);
    const a = auditRows(s.db, 'device.linked');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: s.cli });
    expect(meta(a[0])).toEqual({ mainDeviceId: s.main, cause: 'manual', droppedStanding: false, previousDefaultVaultId: null });
    expect(s.changed().sort()).toEqual([s.cli, s.main].sort());
    const list = (await s.req(s.alice, 'GET', '/api/devices')).json().items as { id: string; linkedTo: unknown }[];
    expect(list.find((d) => d.id === s.cli)!.linkedTo).toEqual({ id: s.main, name: 'main' });
  });

  it('is idempotent for the same main; relinking moves the CLI (previousMainDeviceId)', async () => {
    const s = await setup();
    linkDevice(s.ctx, s.alice.id, s.cli, s.main);
    linkDevice(s.ctx, s.alice.id, s.cli, s.main);
    expect(auditRows(s.db, 'device.linked')).toHaveLength(1);
    s.events.length = 0;
    const dto = linkDevice(s.ctx, s.alice.id, s.cli, s.main2);
    expect(dto.linkedTo).toEqual({ id: s.main2, name: 'main-2' });
    const a = auditRows(s.db, 'device.linked');
    expect(a).toHaveLength(2);
    expect(meta(a[1])).toMatchObject({ mainDeviceId: s.main2, previousMainDeviceId: s.main, cause: 'manual' });
    expect(s.changed().sort()).toEqual([s.cli, s.main, s.main2].sort());
  });

  it('validation matrix: not own, self, kinds, main state, CLI state', async () => {
    const s = await setup();
    const bobCli = s.pair('cli', 'bob-cli', s.bob.id);
    const bobMain = s.pair('mcp', 'bob-main', s.bob.id);
    const otherCli = s.pair('cli', 'cli-2');
    const err = async (cliId: string, mainId: string) => {
      const r = await s.put(cliId, mainId);
      return [r.statusCode, r.json().error];
    };
    expect(await err(bobCli, s.main)).toEqual([404, 'not_found']);
    expect(await err('dev_nope', s.main)).toEqual([404, 'not_found']);
    expect(await err(s.cli, bobMain)).toEqual([404, 'main_not_found']);
    expect(await err(s.cli, 'dev_nope')).toEqual([404, 'main_not_found']);
    expect(await err(s.cli, s.cli)).toEqual([400, 'invalid_link']);
    expect(await err(s.main, s.main)).toEqual([400, 'invalid_link']);
    expect(await err(s.cli, otherCli)).toEqual([400, 'invalid_link']); // target is a cli
    expect(await err(s.main2, s.main)).toEqual([400, 'invalid_link']); // source is an mcp device
    s.setStatus(s.main2, 'revoked');
    expect(await err(s.cli, s.main2)).toEqual([404, 'main_not_found']);
    s.setStatus(s.main2, 'pending');
    expect(await err(s.cli, s.main2)).toEqual([404, 'main_not_found']);
    s.setStatus(otherCli, 'revoked');
    expect(await err(otherCli, s.main)).toEqual([409, 'device_inactive']);
    s.setStatus(otherCli, 'pending');
    expect(await err(otherCli, s.main)).toEqual([409, 'device_inactive']);
    expect((await s.req(s.alice, 'PUT', `/api/devices/${s.cli}/link`, {})).statusCode).toBe(400);
    expect((await s.req(s.alice, 'PUT', `/api/devices/${s.cli}/link`, { mainDeviceId: s.main, x: 1 })).statusCode).toBe(400);
    expect(auditRows(s.db, 'device.linked')).toHaveLength(0);
    expect(s.row(s.cli).linkedTo).toBeNull();
  });

  it("drops the CLI's own standing approval and default vault (audited with cause device_linked)", async () => {
    const s = await setup();
    const team = createVault(s.ctx, s.alice.id, 'Team');
    setStandingApproval(s.ctx, s.alice.id, s.cli, StandingApprovalInputSchema.parse({ until: s.clock.now() + 7 * DAY, scope: 'all' }), {});
    setDeviceDefaultVault(s.ctx, s.alice.id, s.cli, team.id);
    linkDevice(s.ctx, s.alice.id, s.cli, s.main, { ip: '1.2.3.4' });
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM standing_approvals WHERE device_id = ?').get(s.cli)).toEqual({ n: 0 });
    expect(s.row(s.cli).defaultVaultId).toBeNull();
    const removed = auditRows(s.db, 'standing_approval.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: s.cli });
    expect(meta(removed[0])).toMatchObject({ cause: 'device_linked' });
    const dv = auditRows(s.db, 'device.default_vault_changed');
    expect(dv).toHaveLength(2);
    expect(meta(dv[1])).toEqual({ previousVaultId: team.id, vaultId: null, cause: 'device_linked' });
    expect(meta(auditRows(s.db, 'device.linked')[0])).toEqual({
      mainDeviceId: s.main, cause: 'manual', droppedStanding: true, previousDefaultVaultId: team.id,
    });
  });

  it('setting a default vault on an attached CLI -> 409 device_linked', async () => {
    const s = await setup();
    linkDevice(s.ctx, s.alice.id, s.cli, s.main);
    const r = await s.req(s.alice, 'PUT', `/api/devices/${s.cli}/default-vault`, { vaultId: null });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'device_linked' });
  });

  it('unlinks via DELETE (idempotent, audited, settings stay empty)', async () => {
    const s = await setup();
    linkDevice(s.ctx, s.alice.id, s.cli, s.main);
    s.events.length = 0;
    const res = await s.del(s.cli);
    expect(res.statusCode).toBe(200);
    expect(DeviceDtoSchema.parse(res.json())).toMatchObject({ id: s.cli, linkedTo: null, standingApproval: null });
    expect(s.row(s.cli)).toMatchObject({ linkedTo: null, defaultVaultId: null });
    const a = auditRows(s.db, 'device.unlinked');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_type: 'user', actor_id: s.alice.id, device_id: s.cli });
    expect(meta(a[0])).toEqual({ mainDeviceId: s.main, cause: 'manual' });
    expect(s.changed().sort()).toEqual([s.cli, s.main].sort());
    expect((await s.del(s.cli)).statusCode).toBe(200);
    expect(auditRows(s.db, 'device.unlinked')).toHaveLength(1);
    expect((await s.del(s.cli, s.bob)).statusCode).toBe(404);
    expect(() => unlinkDevice(s.ctx, s.alice.id, 'dev_nope')).toThrow();
  });

  it('PUT and DELETE require recent auth', async () => {
    const s = await setup();
    linkDevice(s.ctx, s.alice.id, s.cli, s.main2);
    s.clock.advance(10 * 60_000 + 1);
    for (const r of [await s.put(s.cli, s.main), await s.del(s.cli)]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'reauth_required' });
    }
    expect(s.row(s.cli).linkedTo).toBe(s.main2);
    expect((await s.req(undefined, 'PUT', `/api/devices/${s.cli}/link`, { mainDeviceId: s.main })).statusCode).toBe(401);
  });
});

describe('revocation with attached CLIs', () => {
  async function group() {
    const s = await setup();
    const cli2 = s.pair('cli', 'cli-2');
    linkDevice(s.ctx, s.alice.id, s.cli, s.main);
    linkDevice(s.ctx, s.alice.id, cli2, s.main);
    s.events.length = 0;
    return { ...s, cli2 };
  }

  it('user revoke of the main device revokes attached CLIs by default (cause main_revoked)', async () => {
    const s = await group();
    const res = await s.req(s.alice, 'POST', `/api/devices/${s.main}/revoke`);
    expect(res.statusCode).toBe(200);
    for (const id of [s.main, s.cli, s.cli2]) expect(s.row(id)).toMatchObject({ status: 'revoked', linkedTo: null });
    const rev = auditRows(s.db, 'device.revoked');
    expect(rev.map((r) => r.device_id)).toEqual([s.main, s.cli, s.cli2]);
    expect(meta(rev[0])).toBeNull();
    for (const r of rev.slice(1)) {
      expect(r).toMatchObject({ actor_type: 'user', actor_id: s.alice.id });
      expect(meta(r)).toEqual({ cause: 'main_revoked' });
    }
    expect(auditRows(s.db, 'device.unlinked')).toHaveLength(0);
    expect(s.changed().sort()).toEqual([s.main, s.cli, s.cli2].sort());
    expect(s.db.$client.prepare('SELECT count(*) AS n FROM tokens WHERE device_id IN (?, ?) AND revoked_at IS NULL').get(s.cli, s.cli2)).toEqual({ n: 0 });
  });

  it("attached 'detach' keeps the CLIs approved and unlinked (device.unlinked cause main_revoked)", async () => {
    const s = await group();
    const res = await s.req(s.alice, 'POST', `/api/devices/${s.main}/revoke`, { attached: 'detach' });
    expect(res.statusCode).toBe(200);
    expect(s.row(s.main).status).toBe('revoked');
    for (const id of [s.cli, s.cli2]) expect(s.row(id)).toMatchObject({ status: 'approved', linkedTo: null });
    expect(auditRows(s.db, 'device.revoked').map((r) => r.device_id)).toEqual([s.main]);
    const un = auditRows(s.db, 'device.unlinked');
    expect(un.map((r) => r.device_id)).toEqual([s.cli, s.cli2]);
    for (const r of un) {
      expect(r).toMatchObject({ actor_type: 'user', actor_id: s.alice.id });
      expect(meta(r)).toEqual({ mainDeviceId: s.main, cause: 'main_revoked' });
    }
    expect(s.changed().sort()).toEqual([s.main, s.cli, s.cli2].sort());
    expect((await s.req(s.alice, 'POST', `/api/devices/${s.main}/revoke`, { attached: 'nope' })).statusCode).toBe(400);
  });

  it('system revoke defaults to detach; refresh-token reuse on the main device detaches its CLIs', async () => {
    const s = await setup();
    const p = pairDevice(s.ctx, { userId: s.alice.id, kind: 'mcp', name: 'reused' });
    linkDevice(s.ctx, s.alice.id, s.cli, p.deviceId);
    const refresh = (app: FastifyInstance, token: string) =>
      app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: token } });
    expect((await refresh(s.app, p.refreshToken)).statusCode).toBe(200);
    expect((await refresh(s.app, p.refreshToken)).json().error).toBe('invalid_grant');
    expect(s.row(p.deviceId).status).toBe('revoked');
    expect(s.row(s.cli)).toMatchObject({ status: 'approved', linkedTo: null });
    expect(meta(auditRows(s.db, 'device.revoked')[0])).toEqual({ cause: 'refresh_reuse' });
    const un = auditRows(s.db, 'device.unlinked');
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ actor_type: 'system', actor_id: null, device_id: s.cli });
    expect(meta(un[0])).toEqual({ mainDeviceId: p.deviceId, cause: 'main_revoked' });

    // explicit system revoke of another main also detaches by default
    linkDevice(s.ctx, s.alice.id, s.cli, s.main2);
    revokeDevice(s.ctx, s.main2, { type: 'system', cause: 'test' });
    expect(s.row(s.cli)).toMatchObject({ status: 'approved', linkedTo: null });
  });

  it('revoking an attached CLI revokes only it and clears its link', async () => {
    const s = await group();
    const res = await s.req(s.alice, 'POST', `/api/devices/${s.cli}/revoke`);
    expect(res.json()).toMatchObject({ status: 'revoked', linkedTo: null });
    expect(s.row(s.main).status).toBe('approved');
    expect(s.row(s.cli2)).toMatchObject({ status: 'approved', linkedTo: s.main });
    expect(auditRows(s.db, 'device.revoked').map((r) => r.device_id)).toEqual([s.cli]);
    expect(s.changed().sort()).toEqual([s.cli, s.main].sort());
  });

  it('disabling a user revokes the whole group once', async () => {
    const s = await group();
    disableUser(s.ctx, s.alice.id, s.bob.id); // unrelated user: nothing happens to alice's group
    expect(s.row(s.main).status).toBe('approved');
    const bobMain = s.pair('mcp', 'bob-main', s.bob.id);
    const bobCli = s.pair('cli', 'bob-cli', s.bob.id);
    linkDevice(s.ctx, s.bob.id, bobCli, bobMain);
    disableUser(s.ctx, s.alice.id, s.bob.id);
    for (const id of [bobMain, bobCli]) expect(s.row(id)).toMatchObject({ status: 'revoked', linkedTo: null });
    const rev = auditRows(s.db, 'device.revoked').filter((r) => r.device_id === bobMain || r.device_id === bobCli);
    expect(rev).toHaveLength(2);
    for (const r of rev) expect(r).toMatchObject({ actor_type: 'user', actor_id: s.alice.id });
  });
});

describe('activation with a link', () => {
  async function pending(s: Awaited<ReturnType<typeof setup>>) {
    const res = await s.app.inject({
      method: 'POST', url: '/oauth/device_authorization',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ client_name: 'asm CLI', hostname: 'box' }).toString(),
    });
    return res.json().user_code as string;
  }
  const newDeviceId = (s: Awaited<ReturnType<typeof setup>>) =>
    (s.db.$client.prepare("SELECT id FROM devices WHERE name = 'asm CLI'").get() as { id: string }).id;

  it('GET lists candidates; suggestedLinkId only with exactly one candidate', async () => {
    const s = await setup();
    const code = await pending(s);
    const info = (await s.req(s.alice, 'GET', `/api/devices/activate?user_code=${code}`)).json();
    ActivationInfoSchema.parse(info);
    expect(info.linkCandidates.map((c: { id: string }) => c.id).sort()).toEqual([s.main, s.main2].sort());
    expect(info.suggestedLinkId).toBeNull();
    s.setStatus(s.main2, 'revoked');
    const one = (await s.req(s.alice, 'GET', `/api/devices/activate?user_code=${code}`)).json();
    ActivationInfoSchema.parse(one);
    expect(one.linkCandidates).toEqual([{ id: s.main, name: 'main', lastUsedAt: null, createdAt: s.clock.now(), attachedCount: 0 }]);
    expect(one.suggestedLinkId).toBe(s.main);
    const none = (await s.req(s.bob, 'GET', `/api/devices/activate?user_code=${code}`)).json();
    expect(ActivationInfoSchema.parse(none)).toMatchObject({ linkCandidates: [], suggestedLinkId: null });
  });

  it('approve with link_to_device_id attaches the new CLI (cause activation, device.approved meta.linkedTo)', async () => {
    const s = await setup();
    const code = await pending(s);
    const r = await s.req(s.alice, 'POST', '/api/devices/activate', { user_code: code, decision: 'approve', link_to_device_id: s.main });
    expect(r.statusCode).toBe(200);
    const id = newDeviceId(s);
    expect(s.row(id)).toMatchObject({ status: 'approved', linkedTo: s.main });
    expect(meta(auditRows(s.db, 'device.approved')[0])).toEqual({ linkedTo: s.main });
    expect(meta(auditRows(s.db, 'device.linked')[0])).toEqual({ mainDeviceId: s.main, cause: 'activation', droppedStanding: false, previousDefaultVaultId: null });
    expect(auditRows(s.db, 'standing_approval.removed')).toHaveLength(0);
    expect(s.changed().sort()).toEqual([id, s.main].sort());
  });

  it('a foreign or invalid link target -> 404 main_not_found, nothing approved', async () => {
    const s = await setup();
    const bobMain = s.pair('mcp', 'bob-main', s.bob.id);
    const code = await pending(s);
    for (const target of [bobMain, 'dev_nope', s.cli]) {
      const r = await s.req(s.alice, 'POST', '/api/devices/activate', { user_code: code, decision: 'approve', link_to_device_id: target });
      expect(r.statusCode).toBe(target === s.cli ? 400 : 404);
      expect(r.json().error).toBe(target === s.cli ? 'invalid_link' : 'main_not_found');
    }
    expect(s.row(newDeviceId(s))).toMatchObject({ status: 'pending', linkedTo: null });
    expect(auditRows(s.db, 'device.approved')).toHaveLength(0);
    // still approvable afterwards; null link = no link
    const ok = await s.req(s.alice, 'POST', '/api/devices/activate', { user_code: code, decision: 'approve', link_to_device_id: null });
    expect(ok.statusCode).toBe(200);
    expect(s.row(newDeviceId(s))).toMatchObject({ status: 'approved', linkedTo: null });
    expect(meta(auditRows(s.db, 'device.approved')[0])).toBeNull();
  });

  it('deny ignores a link; activation with a link requires recent auth', async () => {
    const s = await setup();
    s.clock.advance(10 * 60_000 + 1);
    const code = await pending(s);
    const stale = await s.req(s.alice, 'POST', '/api/devices/activate', { user_code: code, decision: 'approve', link_to_device_id: s.main });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    const fresh = { ...s.alice, cookie: await login(s.app, 'alice') };
    const d = await s.req(fresh, 'POST', '/api/devices/activate', { user_code: code, decision: 'deny', link_to_device_id: s.main });
    expect(d.statusCode).toBe(200);
    expect(s.row(newDeviceId(s))).toMatchObject({ status: 'denied', linkedTo: null });
    expect(auditRows(s.db, 'device.linked')).toHaveLength(0);
  });
});
