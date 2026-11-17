import { describe, expect, it } from 'vitest';
import {
  AccessRequestDtoSchema, DeviceDtoSchema, StandingApprovalInputSchema, StandingApprovalResponseSchema, newId,
  type StandingApprovalInputRaw,
} from '@asm/shared';
import type { Actor } from '../src/context.js';
import { devices } from '../src/db/schema.js';
import { listDevices, revokeDevice } from '../src/devices/service.js';
import { HttpError } from '../src/errors.js';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import { enableAutoMode } from '../src/requests/automode.js';
import type { RequestEvent } from '../src/requests/events.js';
import { grantIdForRequest } from '../src/requests/grants.js';
import { createRequest, createUpdateRequest, decideRequest, expireDue } from '../src/requests/service.js';
import { archiveSecret, createSecret, deleteSecret } from '../src/secrets/service.js';
import { listVersions } from '../src/secrets/versions.js';
import { getStandingApproval, removeStandingApproval, setStandingApproval } from '../src/standing/service.js';
import { addMember, createVault, removeMember } from '../src/vaults/service.js';
import { ORIGIN, auditRows, pairDevice, world } from './helpers/fixtures.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type World = Awaited<ReturnType<typeof world>>;

function expectHttp(fn: () => unknown, status: number, code?: string) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an error').toBeInstanceOf(HttpError);
  expect((err as HttpError).statusCode, String(err)).toBe(status);
  if (code) expect((err as HttpError).code).toBe(code);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const meta = (row: Record<string, unknown> | undefined) => JSON.parse(String(row?.meta ?? 'null')) as Record<string, unknown> | null;

async function setup(opts: { maxDays?: number } = {}) {
  const w = await world(opts.maxDays === undefined ? {} : { app: { config: { standingMaxDays: opts.maxDays } } });
  const secret = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Key', envName: 'STRIPE_KEY', value: 'sk' });
  const other = createSecret(w.ctx, w.alice.actor, { title: 'Other', value: 'o', allowPlaintextToAgent: true });
  const paired = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
  const dev: DeviceIdentity = { id: paired.deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' };
  const devActor: Actor = { type: 'device', deviceId: dev.id, userId: w.alice.id };
  const read = (secretId = secret.id, device = dev, delivery: 'cli' | 'plaintext' = 'cli') =>
    createRequest(w.ctx, { device, secretId, project: 'p', reason: 'r', delivery });
  const update = (secretId = secret.id, device = dev) =>
    createUpdateRequest(w.ctx, { device, secretId, project: 'p', reason: 'rotate', value: `v-${newId('req')}` });
  const set = (input: Partial<StandingApprovalInputRaw> = {}, deviceId = dev.id, userId = w.alice.id) =>
    setStandingApproval(w.ctx, userId, deviceId, StandingApprovalInputSchema.parse({ until: w.clock.now() + 7 * DAY, scope: 'all', ...input }), {});
  const get = (deviceId = dev.id) => getStandingApproval(w.ctx, w.alice.id, deviceId);
  const approve = (requestId: string) => decideRequest(w.ctx, { requestId, userId: w.alice.id, decision: 'approve' });
  const deny = (requestId: string) => decideRequest(w.ctx, { requestId, userId: w.alice.id, decision: 'deny' });
  const put = (body: unknown, deviceId = dev.id, cookie = w.alice.cookie) =>
    w.app.inject({
      method: 'PUT', url: `/api/devices/${deviceId}/standing-approval`, headers: { cookie, origin: ORIGIN }, payload: body as Record<string, unknown>,
    });
  const events: RequestEvent[] = [];
  w.ctx.events.subscribe(w.alice.id, (e) => events.push(e));
  const deviceChanged = () => events.filter((e) => (e.type as string) === 'device.changed');
  return { w, secret, other, dev, devActor, read, update, set, get, approve, deny, put, events, deviceChanged };
}

/** Lets a standing approval expire with afterExpiry 'renew'. */
async function expiredRenew(opts: { renewDays?: number; maxDays?: number; scope?: 'all' | 'list' } = {}) {
  const t = await setup({ maxDays: opts.maxDays });
  const until = t.w.clock.now() + 2 * DAY;
  t.set({ until, afterExpiry: 'renew', renewDays: opts.renewDays ?? 10, ...(opts.scope === 'list' ? { scope: 'list', secretIds: [t.secret.id] } : {}) });
  t.w.clock.advance(2 * DAY);
  return { ...t, until };
}

const untilOf = (w: World, deviceId: string) =>
  (w.db.$client.prepare('SELECT until FROM standing_approvals WHERE device_id = ?').get(deviceId) as { until: number } | undefined)?.until;

describe('standing approval: coverage', () => {
  it('covered read: approved immediately with a grant, autoSource standing, audited via standing, no request.created, no push', async () => {
    const t = await setup();
    const res = t.set();
    StandingApprovalResponseSchema.parse(res);
    expect(res).toMatchObject({ maxDays: 90, standingApproval: { active: true, scope: 'all', until: t.w.clock.now() + 7 * DAY, allowUpdates: false } });
    const notified: string[] = [];
    t.w.ctx.hooks.onRequestPending = (_ctx, id) => {
      notified.push(id);
    };

    const r = t.read();
    AccessRequestDtoSchema.parse(r);
    expect(r).toMatchObject({ status: 'approved', auto: true, autoSource: 'standing', renewal: null, decidedBy: null });
    expect(grantIdForRequest(t.w.db, r.id, t.dev.id)).not.toBeNull();
    const auto = auditRows(t.w.db, 'request.auto_approved');
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ actor_type: 'system', secret_id: t.secret.id, device_id: t.dev.id });
    expect(meta(auto[0])).toMatchObject({ via: 'standing', requestId: r.id });
    expect(auditRows(t.w.db, 'request.created')).toHaveLength(0);
    expect(notified).toEqual([]);
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM approve_tokens').get()).toEqual({ n: 0 });
    // Control: a request that is not covered (update without allowUpdates) does reach the push hook.
    const pending = t.update();
    expect(notified).toEqual([pending.id]);
    expect(auditRows(t.w.db, 'standing_approval.set')[0]).toMatchObject({ actor_type: 'user', actor_id: t.w.alice.id, device_id: t.dev.id });
  });

  it('update requests are covered only with allowUpdates', async () => {
    const t = await setup();
    t.set();
    expect(t.update()).toMatchObject({ status: 'pending', autoSource: null });
    t.set({ allowUpdates: true });
    const r = t.update();
    expect(r).toMatchObject({ status: 'approved', auto: true, autoSource: 'standing' });
    expect(listVersions(t.w.db, t.w.alice.id, t.secret.id)).toHaveLength(2);
    expect(meta(auditRows(t.w.db, 'request.auto_approved')[0])).toMatchObject({ via: 'standing', kind: 'update' });
  });

  it('list scope covers only listed secrets', async () => {
    const t = await setup();
    const res = t.set({ scope: 'list', secretIds: [t.secret.id] });
    expect(res.standingApproval).toMatchObject({ scope: 'list', secretCount: 1, secrets: [{ id: t.secret.id, addedBy: 'user', title: 'Stripe Key' }] });
    expect(t.read().status).toBe('approved');
    expect(t.read(t.other.id)).toMatchObject({ status: 'pending', autoSource: null });
  });

  it('boundary: covered until just before until; at now == until not covered', async () => {
    const t = await setup();
    t.set({ until: t.w.clock.now() + DAY });
    t.w.clock.advance(DAY - 1);
    expect(t.read().status).toBe('approved');
    t.w.clock.advance(1);
    expect(t.read()).toMatchObject({ status: 'pending', renewal: null });
    expect(t.get().standingApproval).toMatchObject({ active: false });
  });

  it('plaintext delivery still needs the secret flag', async () => {
    const t = await setup();
    t.set();
    expectHttp(() => t.read(t.secret.id, t.dev, 'plaintext'), 403, 'plaintext_not_allowed');
    expect(t.read(t.other.id, t.dev, 'plaintext')).toMatchObject({ status: 'approved', autoSource: 'standing' });
  });

  it('archived and deleted secrets are not covered (requests fail as before; list entry of a deleted secret is gone)', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [t.secret.id, t.other.id] });
    archiveSecret(t.w.ctx, t.w.alice.actor, t.secret.id, { reason: 'gone' });
    expectHttp(() => t.read(), 409, 'secret_archived');
    deleteSecret(t.w.ctx, t.w.alice.actor, t.other.id);
    expectHttp(() => t.read(t.other.id), 404);
    const sa = t.get().standingApproval!;
    expect(sa.secrets.map((s) => s.id)).toEqual([t.secret.id]);
    expect(sa.secrets[0]).toMatchObject({ archived: true });
  });

  it('vault membership lost: listed secrets of that vault are removed and not re-covered after re-adding', async () => {
    const t = await setup();
    const shared = createVault(t.w.ctx, t.w.bob.id, 'Team');
    addMember(t.w.ctx, t.w.bob.id, shared.id, { username: 'alice' });
    const teamSecret = createSecret(t.w.ctx, t.w.bob.actor, { vaultId: shared.id, title: 'Team Key', value: 't' });
    t.set({ scope: 'list', secretIds: [teamSecret.id, t.secret.id] });
    expect(t.read(teamSecret.id).status).toBe('approved');

    removeMember(t.w.ctx, t.w.bob.id, shared.id, t.w.alice.id);
    expectHttp(() => t.read(teamSecret.id), 404);
    expect(t.get().standingApproval!.secrets.map((s) => s.id)).toEqual([t.secret.id]);

    addMember(t.w.ctx, t.w.bob.id, shared.id, { username: 'alice' });
    expect(t.read(teamSecret.id)).toMatchObject({ status: 'pending', autoSource: null });
  });

  it('vault membership lost with scope all: secrets of that vault are no longer reachable', async () => {
    const t = await setup();
    const shared = createVault(t.w.ctx, t.w.bob.id, 'Team');
    addMember(t.w.ctx, t.w.bob.id, shared.id, { username: 'alice' });
    const teamSecret = createSecret(t.w.ctx, t.w.bob.actor, { vaultId: shared.id, title: 'Team Key', value: 't' });
    t.set();
    expect(t.read(teamSecret.id).status).toBe('approved');
    removeMember(t.w.ctx, t.w.bob.id, shared.id, t.w.alice.id);
    expectHttp(() => t.read(teamSecret.id), 404);
    expect(t.read().status).toBe('approved');
  });

  it('a second device of the same user is not covered', async () => {
    const t = await setup();
    t.set();
    const second = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'cli', name: 'cli' });
    const r = t.read(t.secret.id, { id: second.deviceId, userId: t.w.alice.id, kind: 'cli', name: 'cli' });
    expect(r).toMatchObject({ status: 'pending', autoSource: null, renewal: null });
  });
});

describe('standing approval: after expiry', () => {
  it("afterExpiry 'ask': the next request is pending without renewal", async () => {
    const t = await setup();
    t.set({ until: t.w.clock.now() + DAY });
    t.w.clock.advance(DAY);
    const r = t.read();
    expect(r).toMatchObject({ status: 'pending', renewal: null, autoSource: null });
    expect(auditRows(t.w.db, 'request.created')).toHaveLength(1);
    expect(meta(auditRows(t.w.db, 'request.created')[0])).not.toHaveProperty('renewal');
    t.approve(r.id);
    expect(untilOf(t.w, t.dev.id)).toBe(t.w.clock.now());
  });

  it("afterExpiry 'renew': pending renewal; approve extends by renewDays (audit renewed, device.changed)", async () => {
    const t = await expiredRenew({ renewDays: 10 });
    const r = t.read();
    expect(r).toMatchObject({ status: 'pending', renewal: { days: 10 }, autoSource: null });
    expect(t.w.db.$client.prepare('SELECT standing_renewal AS s FROM access_requests WHERE id = ?').get(r.id)).toEqual({ s: 1 });
    const created = t.events.find((e) => e.type === 'request.created');
    expect(created?.data).toMatchObject({ id: r.id, renewal: { days: 10 } });
    t.events.length = 0;

    const done = t.approve(r.id);
    expect(done).toMatchObject({ status: 'approved', auto: false, autoSource: null });
    expect(grantIdForRequest(t.w.db, r.id, t.dev.id)).not.toBeNull();
    expect(untilOf(t.w, t.dev.id)).toBe(t.w.clock.now() + 10 * DAY);
    const renewed = auditRows(t.w.db, 'standing_approval.renewed');
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatchObject({ actor_type: 'user', actor_id: t.w.alice.id, device_id: t.dev.id });
    await tick();
    expect(t.deviceChanged()).toEqual([{ type: 'device.changed', data: { deviceId: t.dev.id } }]);
    expect(t.get().standingApproval).toMatchObject({ active: true, until: t.w.clock.now() + 10 * DAY });

    expect(t.read()).toMatchObject({ status: 'approved', autoSource: 'standing' });
  });

  it('deny leaves the approval expired; the next request is a renewal again', async () => {
    const t = await expiredRenew();
    const r = t.read();
    t.deny(r.id);
    expect(untilOf(t.w, t.dev.id)).toBe(t.until);
    expect(auditRows(t.w.db, 'standing_approval.renewed')).toHaveLength(0);
    expect(t.read()).toMatchObject({ status: 'pending', renewal: { days: 10 } });
  });

  it('concurrent renewals extend only once', async () => {
    const t = await expiredRenew({ renewDays: 5 });
    const a = t.read();
    const b = t.read(t.other.id);
    expect(a.renewal).toEqual({ days: 5 });
    expect(b.renewal).toEqual({ days: 5 });
    t.approve(a.id);
    const after = untilOf(t.w, t.dev.id);
    expect(after).toBe(t.w.clock.now() + 5 * DAY);
    t.w.clock.advance(MIN);
    expect(t.approve(b.id).status).toBe('approved');
    expect(untilOf(t.w, t.dev.id)).toBe(after);
    expect(auditRows(t.w.db, 'standing_approval.renewed')).toHaveLength(1);
  });

  it('settings changed before the approval -> no extension', async () => {
    const t = await expiredRenew();
    const r = t.read();
    const newUntil = t.w.clock.now() + 3 * DAY;
    t.set({ until: newUntil, afterExpiry: 'renew', renewDays: 10 });
    t.approve(r.id);
    expect(untilOf(t.w, t.dev.id)).toBe(newUntil);
    expect(auditRows(t.w.db, 'standing_approval.renewed')).toHaveLength(0);

    // Switched to 'ask' while a renewal is pending: approving does not extend.
    const t2 = await expiredRenew();
    const r2 = t2.read();
    t2.w.db.$client.prepare("UPDATE standing_approvals SET after_expiry = 'ask' WHERE device_id = ?").run(t2.dev.id);
    t2.approve(r2.id);
    expect(untilOf(t2.w, t2.dev.id)).toBe(t2.until);

    // Removed while pending: approving does not re-create it.
    const t3 = await expiredRenew();
    const r3 = t3.read();
    removeStandingApproval(t3.w.ctx, t3.w.alice.id, t3.dev.id, {});
    t3.approve(r3.id);
    expect(t3.get().standingApproval).toBeNull();
  });

  it('renewal is capped by the admin max (renewDays > lowered max)', async () => {
    const t = await expiredRenew({ renewDays: 30 });
    t.w.ctx.standingMaxDays = 20;
    // granted_at + 20 days already passed? granted 2 days ago -> effective until = min(until, granted+20d) = until (expired).
    const r = t.read();
    expect(r.renewal).toEqual({ days: 20 });
    t.approve(r.id);
    expect(t.get().standingApproval).toMatchObject({ active: true, until: t.w.clock.now() + 20 * DAY });
  });
});

describe('standing approval: caps', () => {
  it('until beyond maxDays or not in the future -> 400 invalid_until; renewDays > max -> 400 invalid_renew_days', async () => {
    const t = await setup();
    const now = t.w.clock.now();
    expectHttp(() => t.set({ until: now + 90 * DAY + 1 }), 400, 'invalid_until');
    expectHttp(() => t.set({ until: now }), 400, 'invalid_until');
    expect(t.set({ until: now + 90 * DAY }).standingApproval).toMatchObject({ active: true });
    expectHttp(() => t.set({ renewDays: 91, afterExpiry: 'renew' }), 400, 'invalid_renew_days');

    const r1 = await t.put({ until: now + 91 * DAY, scope: 'all' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json()).toEqual({ error: 'invalid_until' });
    const r2 = await t.put({ until: now + DAY, scope: 'all', afterExpiry: 'renew', renewDays: 91 });
    expect(r2.statusCode).toBe(400);
    expect(r2.json()).toEqual({ error: 'invalid_renew_days' });
  });

  it('a lowered max clamps the effective until (granted_at + maxDays)', async () => {
    const t = await setup();
    const granted = t.w.clock.now();
    t.set({ until: granted + 60 * DAY });
    t.w.ctx.standingMaxDays = 10;
    expect(t.get()).toMatchObject({ maxDays: 10, standingApproval: { until: granted + 10 * DAY, active: true } });
    t.w.clock.advance(10 * DAY - 1);
    expect(t.read().status).toBe('approved');
    t.w.clock.advance(1);
    expect(t.read().status).toBe('pending');
    expect(t.get().standingApproval).toMatchObject({ active: false });
  });

  it('maxDays 0: PUT -> 403 standing_disabled, existing approvals cover nothing', async () => {
    const t = await setup();
    t.set();
    t.w.ctx.standingMaxDays = 0;
    expect(t.read()).toMatchObject({ status: 'pending', renewal: null });
    expect(t.get()).toMatchObject({ maxDays: 0, standingApproval: { active: false } });
    expectHttp(() => t.set(), 403, 'standing_disabled');

    const off = await setup({ maxDays: 0 });
    const res = await off.put({ until: off.w.clock.now() + DAY, scope: 'all' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'standing_disabled' });
    expect((await off.w.req(off.w.alice, 'GET', `/api/devices/${off.dev.id}/standing-approval`)).json()).toEqual({ standingApproval: null, maxDays: 0 });
  });
});

describe('standing approval: precedence over auto mode', () => {
  it('both active -> approved via standing', async () => {
    const t = await setup();
    t.set();
    enableAutoMode(t.w.ctx, t.w.alice.id, 30);
    expect(t.read()).toMatchObject({ status: 'approved', autoSource: 'standing' });
    expect(meta(auditRows(t.w.db, 'request.auto_approved')[0])).toMatchObject({ via: 'standing' });
  });

  it('auto mode only -> approved via automode', async () => {
    const t = await setup();
    enableAutoMode(t.w.ctx, t.w.alice.id, 30);
    expect(t.read()).toMatchObject({ status: 'approved', auto: true, autoSource: 'automode' });
    expect(meta(auditRows(t.w.db, 'request.auto_approved')[0])).toMatchObject({ via: 'automode' });
  });

  it('auto mode on + expired renew -> auto-approved by auto mode, no renewal', async () => {
    const t = await expiredRenew();
    enableAutoMode(t.w.ctx, t.w.alice.id, 30);
    const r = t.read();
    expect(r).toMatchObject({ status: 'approved', autoSource: 'automode', renewal: null });
    expect(t.w.db.$client.prepare('SELECT standing_renewal AS s FROM access_requests WHERE id = ?').get(r.id)).toEqual({ s: 0 });
    expect(untilOf(t.w, t.dev.id)).toBe(t.until);
    expect(auditRows(t.w.db, 'standing_approval.renewed')).toHaveLength(0);
  });
});

describe('standing approval: includeCreated', () => {
  it('secrets the device creates are added to the list (addedBy device, audited, device.changed)', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [t.secret.id], includeCreated: true });
    t.events.length = 0;
    const created = createSecret(t.w.ctx, t.devActor, { title: 'New DB', value: 'x', project: 'p', reason: 'new service' });
    const sa = t.get().standingApproval!;
    expect(sa.secretCount).toBe(2);
    expect(sa.secrets.find((s) => s.id === created.id)).toMatchObject({ addedBy: 'device' });
    const added = auditRows(t.w.db, 'standing_approval.secret_added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ actor_type: 'device', device_id: t.dev.id, secret_id: created.id });
    await tick();
    expect(t.deviceChanged()).toEqual([{ type: 'device.changed', data: { deviceId: t.dev.id } }]);
    expect(t.read(created.id)).toMatchObject({ status: 'approved', autoSource: 'standing' });
  });

  it('includeCreated with an empty list is allowed (only created secrets)', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [], includeCreated: true });
    expect(t.read().status).toBe('pending');
    const created = createSecret(t.w.ctx, t.devActor, { title: 'New', value: 'x', project: 'p', reason: 'r' });
    expect(t.read(created.id).status).toBe('approved');
  });

  it('flag off or scope all -> nothing added', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [t.secret.id], includeCreated: false });
    const a = createSecret(t.w.ctx, t.devActor, { title: 'A', value: 'x', project: 'p', reason: 'r' });
    expect(t.get().standingApproval!.secrets.map((s) => s.id)).toEqual([t.secret.id]);
    expect(t.read(a.id).status).toBe('pending');

    t.set({ scope: 'all', includeCreated: true });
    createSecret(t.w.ctx, t.devActor, { title: 'B', value: 'x', project: 'p', reason: 'r' });
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM standing_approval_secrets').get()).toEqual({ n: 0 });
    expect(auditRows(t.w.db, 'standing_approval.secret_added')).toHaveLength(0);
  });
});

describe('standing approval: lifecycle', () => {
  it('revoking the device deletes it (audit removed, cause device_revoked); a re-paired device inherits nothing', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [t.secret.id] });
    revokeDevice(t.w.ctx, t.dev.id, { type: 'user', userId: t.w.alice.id });
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM standing_approvals').get()).toEqual({ n: 0 });
    expect(t.w.db.$client.prepare('SELECT count(*) AS n FROM standing_approval_secrets').get()).toEqual({ n: 0 });
    const removed = auditRows(t.w.db, 'standing_approval.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ device_id: t.dev.id });
    expect(meta(removed[0])).toMatchObject({ cause: 'device_revoked' });
    await tick();
    expect(t.deviceChanged().length).toBeGreaterThanOrEqual(1);

    const again = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'mcp', name: 'agent' });
    expect(getStandingApproval(t.w.ctx, t.w.alice.id, again.deviceId).standingApproval).toBeNull();
    expect(t.read(t.secret.id, { ...t.dev, id: again.deviceId }).status).toBe('pending');
  });

  it('set/remove emit device.changed; remove is audited and idempotent-safe', async () => {
    const t = await setup();
    t.set();
    expect(t.deviceChanged()).toHaveLength(1);
    const res = removeStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id, {});
    expect(res).toEqual({ standingApproval: null, maxDays: 90 });
    expect(t.deviceChanged()).toHaveLength(2);
    expect(auditRows(t.w.db, 'standing_approval.removed')[0]).toMatchObject({ actor_type: 'user', actor_id: t.w.alice.id, device_id: t.dev.id });
    expect(t.read().status).toBe('pending');
  });

  it('sweep (expireDue) audits standing_approval.expired once; reset after a renewal', async () => {
    const t = await setup();
    t.set({ until: t.w.clock.now() + DAY, afterExpiry: 'renew', renewDays: 3 });
    expireDue(t.w.ctx);
    expect(auditRows(t.w.db, 'standing_approval.expired')).toHaveLength(0);
    t.w.clock.advance(DAY);
    t.events.length = 0;
    expireDue(t.w.ctx);
    await tick();
    const exp = auditRows(t.w.db, 'standing_approval.expired');
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ actor_type: 'user', actor_id: t.w.alice.id, device_id: t.dev.id });
    expect(t.deviceChanged()).toHaveLength(1);
    expireDue(t.w.ctx);
    expect(auditRows(t.w.db, 'standing_approval.expired')).toHaveLength(1);
    // The approval stays (expired) — it can still be renewed.
    expect(t.get().standingApproval).toMatchObject({ active: false });

    t.approve(t.read().id);
    t.w.clock.advance(3 * DAY);
    expireDue(t.w.ctx);
    expect(auditRows(t.w.db, 'standing_approval.expired')).toHaveLength(2);
  });

  it('sweep honours a lowered max (effective until)', async () => {
    const t = await setup();
    t.set({ until: t.w.clock.now() + 30 * DAY });
    t.w.ctx.standingMaxDays = 5;
    t.w.clock.advance(5 * DAY);
    expireDue(t.w.ctx);
    expect(auditRows(t.w.db, 'standing_approval.expired')).toHaveLength(1);
  });
});

describe('standing approval: service validation', () => {
  it('list secrets must be accessible; device must be approved and owned', async () => {
    const t = await setup();
    const bobSecret = createSecret(t.w.ctx, t.w.bob.actor, { title: 'Bob', value: 'b' });
    expectHttp(() => t.set({ scope: 'list', secretIds: [bobSecret.id] }), 404, 'secret_not_found');
    expectHttp(() => t.set({ scope: 'list', secretIds: ['sec_nope'] }), 404, 'secret_not_found');
    expectHttp(() => t.set({}, t.dev.id, t.w.bob.id), 404);
    expectHttp(() => getStandingApproval(t.w.ctx, t.w.bob.id, t.dev.id), 404);
    expectHttp(() => removeStandingApproval(t.w.ctx, t.w.bob.id, t.dev.id, {}), 404);

    const pendingId = newId('dev');
    t.w.db.insert(devices).values({ id: pendingId, userId: t.w.alice.id, name: 'p', kind: 'cli', status: 'pending', createdAt: 0 }).run();
    expectHttp(() => t.set({}, pendingId), 409, 'device_inactive');
  });

  it('PUT is a full replace (list entries and flags reset)', async () => {
    const t = await setup();
    t.set({ scope: 'list', secretIds: [t.secret.id, t.other.id], allowUpdates: true, includeCreated: true });
    const res = t.set({ scope: 'list', secretIds: [t.other.id] });
    expect(res.standingApproval).toMatchObject({ allowUpdates: false, includeCreated: false, secretCount: 1, secrets: [{ id: t.other.id }] });
  });
});

describe('standing approval: routes', () => {
  it('GET/PUT/DELETE for the owner; other users get 404; unauthenticated 401', async () => {
    const t = await setup();
    const url = `/api/devices/${t.dev.id}/standing-approval`;
    const empty = await t.w.req(t.w.alice, 'GET', url);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ standingApproval: null, maxDays: 90 });

    const until = t.w.clock.now() + 7 * DAY;
    const put = await t.put({ until, scope: 'list', secretIds: [t.secret.id], afterExpiry: 'renew', renewDays: 3 });
    expect(put.statusCode).toBe(200);
    const body = StandingApprovalResponseSchema.parse(put.json());
    expect(body.standingApproval).toMatchObject({ until, scope: 'list', afterExpiry: 'renew', renewDays: 3, secretCount: 1 });
    expect(StandingApprovalResponseSchema.parse((await t.w.req(t.w.alice, 'GET', url)).json())).toEqual(body);

    expect((await t.w.req(t.w.bob, 'GET', url)).statusCode).toBe(404);
    expect((await t.put({ until, scope: 'all' }, t.dev.id, t.w.bob.cookie)).statusCode).toBe(404);
    expect((await t.w.req(t.w.bob, 'DELETE', url)).statusCode).toBe(404);
    expect((await t.w.req(t.w.alice, 'GET', '/api/devices/dev_nope/standing-approval')).statusCode).toBe(404);
    expect((await t.w.req(undefined, 'GET', url)).statusCode).toBe(401);
    expect(t.get().standingApproval).not.toBeNull();

    const del = await t.w.req(t.w.alice, 'DELETE', url);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ standingApproval: null, maxDays: 90 });
  });

  it('PUT validates the body (400 invalid_request), incl. an empty list', async () => {
    const t = await setup();
    const until = t.w.clock.now() + DAY;
    for (const bad of [{}, { until, scope: 'some' }, { until: 'x', scope: 'all' }, { until, scope: 'list' }, { until, scope: 'all', extra: 1 }, { until, scope: 'all', renewDays: 0 }]) {
      const res = await t.put(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    }
    expect(t.get().standingApproval).toBeNull();
  });

  it('PUT needs a recent login; DELETE does not', async () => {
    const t = await setup();
    t.set();
    t.w.clock.advance(10 * MIN + 1);
    const res = await t.put({ until: t.w.clock.now() + DAY, scope: 'all' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'reauth_required' });
    const del = await t.w.req(t.w.alice, 'DELETE', `/api/devices/${t.dev.id}/standing-approval`);
    expect(del.statusCode).toBe(200);
    expect(t.get().standingApproval).toBeNull();
  });

  it('PUT on a device that is not approved -> 409 device_inactive', async () => {
    const t = await setup();
    revokeDevice(t.w.ctx, t.dev.id, { type: 'user', userId: t.w.alice.id });
    const res = await t.put({ until: t.w.clock.now() + DAY, scope: 'all' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'device_inactive' });
  });

  it('GET /api/devices includes the summary', async () => {
    const t = await setup();
    const second = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'cli', name: 'cli' });
    const until = t.w.clock.now() + 7 * DAY;
    t.set({ until, scope: 'list', secretIds: [t.secret.id], allowUpdates: true });
    const items = (await t.w.req(t.w.alice, 'GET', '/api/devices')).json().items as { id: string; standingApproval: unknown }[];
    for (const it of items) DeviceDtoSchema.parse(it);
    expect(items).toHaveLength(2);
    expect(items.find((d) => d.id === t.dev.id)!.standingApproval).toEqual({
      until, active: true, scope: 'list', secretCount: 1, allowUpdates: true, afterExpiry: 'ask', renewDays: 7,
    });
    expect(items.find((d) => d.id === second.deviceId)!.standingApproval).toBeNull();
    t.w.clock.advance(7 * DAY);
    // (the session would have expired by now: check through the service)
    expect(listDevices(t.w.ctx, t.w.alice.id).find((d) => d.id === t.dev.id)!.standingApproval).toMatchObject({ active: false, until });
  });
});
