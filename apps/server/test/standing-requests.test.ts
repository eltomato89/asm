import { describe, expect, it } from 'vitest';
import { StandingApprovalInputSchema, StandingRequestDtoSchema, type StandingProposal } from '@asm/shared';
import { createUser } from '../src/auth/setup.js';
import { revokeDevice } from '../src/devices/service.js';
import { HttpError } from '../src/errors.js';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import type { RequestEvent } from '../src/requests/events.js';
import { createRequest, expireDue } from '../src/requests/service.js';
import { archiveSecret, createSecret } from '../src/secrets/service.js';
import {
  createStandingRequest,
  decideStandingRequest,
  getStandingRequestDto,
  listStandingRequests,
  standingRequestDiff,
  standingRequestEligibility,
  waitForStandingRequest,
  type StandingRequestCreateInput,
} from '../src/standing/requests.js';
import { getStandingApproval, setStandingApproval } from '../src/standing/service.js';
import { createVault } from '../src/vaults/service.js';
import { ORIGIN, auditRows, pairDevice, world } from './helpers/fixtures.js';
import { createTestApp } from './helpers/testApp.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function catchHttp(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

function expectHttp(fn: () => unknown, status: number, code: string) {
  const err = catchHttp(fn);
  expect(err.statusCode, err.code).toBe(status);
  expect(err.code).toBe(code);
  return err;
}

const meta = (row: Record<string, unknown> | undefined) => JSON.parse(String(row?.meta ?? 'null')) as Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(app: { standingMaxDays?: number; standingRequestMaxDays?: number } = {}) {
  const w = await world({ app: { config: app } });
  const s1 = createSecret(w.ctx, w.alice.actor, { title: 'Stripe', envName: 'STRIPE_KEY', value: 'a' });
  const s2 = createSecret(w.ctx, w.alice.actor, { title: 'Github', value: 'b' });
  const s3 = createSecret(w.ctx, w.alice.actor, { title: 'Other', value: 'c' });
  const team = createVault(w.ctx, w.alice.id, 'Team');
  const paired = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
  const dev: DeviceIdentity = { id: paired.deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' };
  const propose = (over: Partial<StandingRequestCreateInput> = {}, device = dev) =>
    createStandingRequest(w.ctx, device, {
      scope: 'list', vaultIds: [], secretIds: [s1.id, s2.id], days: 7, afterExpiry: 'ask', renewDays: null,
      project: 'my-repo', reason: 'deploys every day', ...over,
    });
  const decide = (id: string, decision: 'approve' | 'deny', settings?: StandingProposal, auditMeta: Record<string, string> = {}) =>
    decideStandingRequest(w.ctx, { id, userId: w.alice.id, decision, ...(settings ? { settings } : {}) }, {}, auditMeta);
  const events: RequestEvent[] = [];
  w.ctx.events.subscribe(w.alice.id, (e) => events.push(e));
  const decideHttp = (id: string, body: unknown, cookie = w.alice.cookie) =>
    w.app.inject({
      method: 'POST', url: `/api/standing-requests/${id}/decision`, headers: { cookie, origin: ORIGIN }, payload: body as Record<string, unknown>,
    });
  return { w, s1, s2, s3, team, dev, propose, decide, events, decideHttp };
}

describe('createStandingRequest', () => {
  it('creates a pending proposal (DTO, audit with project/reason, event, push hook)', async () => {
    const t = await setup();
    const pushed: string[] = [];
    t.w.ctx.hooks.onStandingRequestPending = (_c, id) => pushed.push(id);
    const dto = t.propose({ secretIds: [t.s1.id, t.s1.id, t.s2.id], vaultIds: [t.team.id] });
    expect(StandingRequestDtoSchema.parse(dto)).toBeTruthy();
    expect(dto).toMatchObject({
      status: 'pending', device: { id: t.dev.id, name: 'agent', kind: 'mcp' }, attachedCli: [], project: 'my-repo', reason: 'deploys every day',
      // Deduped; ids of the other scope dropped.
      proposal: { scope: 'list', vaultIds: [], secretIds: [t.s1.id, t.s2.id], days: 7, afterExpiry: 'ask', renewDays: null },
      limits: { maxDays: 14 }, final: null, adjusted: false, cause: null, decidedBy: null, decidedAt: null,
      expiresAt: t.w.clock.now() + 30 * MIN,
    });
    expect(dto.id).toMatch(/^srq_/);
    expect(dto.items.secrets).toEqual([
      { id: t.s1.id, title: 'Stripe', envName: 'STRIPE_KEY', vaultName: expect.any(String), available: true },
      { id: t.s2.id, title: 'Github', envName: null, vaultName: expect.any(String), available: true },
    ]);
    const [a] = auditRows(t.w.db, 'standing_request.created');
    expect(a).toMatchObject({ actor_type: 'device', actor_id: t.dev.id, device_id: t.dev.id, project: 'my-repo', reason: 'deploys every day' });
    expect(meta(a)).toMatchObject({ requestId: dto.id, scope: 'list', secretIds: [t.s1.id, t.s2.id], days: 7 });
    expect(t.events.map((e) => e.type)).toContain('standing_request.created');
    expect(pushed).toEqual([dto.id]);
    expect(listStandingRequests(t.w.ctx, t.w.alice.id, 'pending').map((r) => r.id)).toEqual([dto.id]);
    expect(listStandingRequests(t.w.ctx, t.w.bob.id, 'all')).toEqual([]);
  });

  it('notes the attached CLI', async () => {
    const t = await setup();
    const cli = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'cli', name: 'laptop-cli' });
    t.w.db.$client.prepare('UPDATE devices SET linked_to_device_id = ?, hostname = ? WHERE id = ?').run(t.dev.id, 'mbp', cli.deviceId);
    expect(t.propose().attachedCli).toEqual([{ name: 'laptop-cli', hostname: 'mbp' }]);
    // The attached CLI itself may not propose.
    expectHttp(() => t.propose({}, { id: cli.deviceId, userId: t.w.alice.id, kind: 'cli', name: 'laptop-cli' }), 403, 'standing_request_mcp_only');
  });

  it('validation: no all / allowUpdates / includeCreated, days and renewDays within the max, own active items only', async () => {
    const t = await setup();
    const bobSecret = createSecret(t.w.ctx, t.w.bob.actor, { title: 'Bob', value: 'x' });
    const bobVault = createVault(t.w.ctx, t.w.bob.id, 'Bobs');
    for (const bad of [{ scope: 'all' }, { allowUpdates: true }, { includeCreated: true }, { days: 0 }]) {
      expect(() => t.propose(bad as never)).toThrow();
    }
    expectHttp(() => t.propose({ days: 15 }), 400, 'invalid_days');
    expectHttp(() => t.propose({ afterExpiry: 'renew', renewDays: null }), 400, 'invalid_renew_days');
    expectHttp(() => t.propose({ afterExpiry: 'renew', renewDays: 15 }), 400, 'invalid_renew_days');
    expectHttp(() => t.propose({ secretIds: [] }), 400, 'empty_list');
    expectHttp(() => t.propose({ scope: 'vaults', vaultIds: [] }), 400, 'empty_list');
    expectHttp(() => t.propose({ secretIds: [t.s1.id, bobSecret.id] }), 404, 'secret_not_found');
    expectHttp(() => t.propose({ scope: 'vaults', vaultIds: [bobVault.id] }), 404, 'vault_not_found');
    archiveSecret(t.w.ctx, t.w.alice.actor, t.s2.id, { reason: "gone" });
    expectHttp(() => t.propose(), 409, 'secret_archived');
    expect(auditRows(t.w.db, 'standing_request.created')).toHaveLength(0);
    // ask normalizes renewDays to null; renew keeps it.
    expect(t.propose({ secretIds: [t.s1.id], afterExpiry: 'ask', renewDays: 5 }).proposal.renewDays).toBeNull();
  });

  it('days are capped by the smaller of both maxes', async () => {
    const t = await setup({ standingMaxDays: 5, standingRequestMaxDays: 5 });
    expectHttp(() => t.propose({ days: 6 }), 400, 'invalid_days');
    expect(t.propose({ days: 5 }).limits).toEqual({ maxDays: 5 });
  });

  it('eligibility: disabled (either max 0)', async () => {
    for (const cfg of [{ standingRequestMaxDays: 0 }, { standingMaxDays: 0, standingRequestMaxDays: 0 }]) {
      const t = await setup(cfg);
      expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toEqual({ allowed: false, reason: 'disabled', maxDays: 0 });
      expectHttp(() => t.propose(), 403, 'standing_requests_disabled');
    }
  });

  it('eligibility: active standing approval, pending, cooldown after deny, 3 per 24 h', async () => {
    const t = await setup();
    expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toEqual({ allowed: true, maxDays: 14 });

    // Active standing approval blocks; an expired one does not.
    setStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id, StandingApprovalInputSchema.parse({ until: t.w.clock.now() + DAY, scope: 'all' }));
    expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toMatchObject({ allowed: false, reason: 'active' });
    expectHttp(() => t.propose(), 409, 'standing_active');
    t.w.clock.advance(DAY);
    expect(standingRequestEligibility(t.w.ctx, t.dev.id).allowed).toBe(true);

    // One open proposal.
    const p1 = t.propose();
    expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toMatchObject({ allowed: false, reason: 'pending', pendingId: p1.id });
    const err = expectHttp(() => t.propose(), 409, 'standing_request_pending');
    expect(err.details).toEqual({ request_id: p1.id });

    // Deny → 24 h cooldown.
    t.w.clock.advance(MIN);
    t.decide(p1.id, 'deny');
    const deniedAt = t.w.clock.now();
    expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toMatchObject({ reason: 'cooldown', retryAfter: deniedAt + DAY });
    const cd = expectHttp(() => t.propose(), 429, 'standing_request_cooldown');
    expect(cd.details).toEqual({ retry_after: new Date(deniedAt + DAY).toISOString() });
    t.w.clock.advance(DAY);
    expect(standingRequestEligibility(t.w.ctx, t.dev.id).allowed).toBe(true);

    // 3 per 24 h (expired ones count too).
    const firstAt = t.w.clock.now();
    for (let i = 0; i < 3; i++) {
      t.propose();
      t.w.clock.advance(31 * MIN);
      expireDue(t.w.ctx);
    }
    expect(standingRequestEligibility(t.w.ctx, t.dev.id)).toMatchObject({ reason: 'limit', retryAfter: firstAt + DAY });
    const lim = expectHttp(() => t.propose(), 429, 'standing_request_limit');
    expect(lim.details).toEqual({ retry_after: new Date(firstAt + DAY).toISOString() });
    t.w.clock.set(firstAt + DAY);
    expect(standingRequestEligibility(t.w.ctx, t.dev.id).allowed).toBe(true);
  });

  it('an overdue, unswept proposal does not block a new one', async () => {
    const t = await setup();
    const p1 = t.propose();
    t.w.clock.advance(30 * MIN);
    const p2 = t.propose();
    expect(getStandingRequestDto(t.w.ctx, p1.id).status).toBe('expired');
    expect(p2.status).toBe('pending');
  });
});

describe('decideStandingRequest', () => {
  it('approve as proposed writes the standing approval with origin; covered secrets are auto-approved afterwards', async () => {
    const t = await setup();
    const p = t.propose({ afterExpiry: 'renew', renewDays: 5 });
    t.events.length = 0;
    const dto = t.decide(p.id, 'approve', undefined, { via: 'push' });
    expect(dto).toMatchObject({ status: 'approved', adjusted: false, final: p.proposal, decidedBy: 'alice', decidedAt: t.w.clock.now() });
    const sa = getStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id).standingApproval!;
    expect(sa).toMatchObject({
      scope: 'list', until: t.w.clock.now() + 7 * DAY, includeCreated: false, allowUpdates: false, afterExpiry: 'renew', renewDays: 5,
    });
    expect(sa.secrets.map((s) => s.id).sort()).toEqual([t.s1.id, t.s2.id].sort());
    const set = auditRows(t.w.db, 'standing_approval.set');
    expect(meta(set.at(-1)).origin).toEqual({ type: 'agent_request', requestId: p.id, proposed: p.proposal, diff: {} });
    const approved = auditRows(t.w.db, 'standing_request.approved');
    expect(approved[0]).toMatchObject({ actor_type: 'user', actor_id: t.w.alice.id, device_id: t.dev.id, project: 'my-repo' });
    expect(meta(approved[0])).toMatchObject({ requestId: p.id, via: 'push', adjusted: false, diff: {}, final: p.proposal });
    expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(['standing_request.updated', 'device.changed']));

    const covered = createRequest(t.w.ctx, { device: t.dev, secretId: t.s1.id, project: 'my-repo', reason: 'r', delivery: 'cli' });
    expect(covered).toMatchObject({ status: 'approved', autoSource: 'standing' });
    const other = createRequest(t.w.ctx, { device: t.dev, secretId: t.s3.id, project: 'my-repo', reason: 'r', delivery: 'cli' });
    expect(other.status).toBe('pending');

    expectHttp(() => t.decide(p.id, 'deny'), 409, 'already_decided');
  });

  it('narrowing: fewer secrets, fewer days, renew → ask; recorded as diff', async () => {
    const t = await setup();
    const p = t.propose({ afterExpiry: 'renew', renewDays: 5 });
    const settings: StandingProposal = { ...p.proposal, secretIds: [t.s2.id], days: 3, afterExpiry: 'ask', renewDays: null };
    const dto = t.decide(p.id, 'approve', settings);
    const diff = { days: { from: 7, to: 3 }, removedSecretIds: [t.s1.id], afterExpiry: { from: 'renew', to: 'ask' }, renewDays: { from: 5, to: null } };
    expect(dto).toMatchObject({ adjusted: true, final: settings });
    expect(meta(auditRows(t.w.db, 'standing_request.approved')[0])).toMatchObject({ adjusted: true, diff });
    expect(meta(auditRows(t.w.db, 'standing_approval.set').at(-1)).origin).toMatchObject({ diff });
    const sa = getStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id).standingApproval!;
    expect(sa).toMatchObject({ until: t.w.clock.now() + 3 * DAY, afterExpiry: 'ask', renewDays: 7 });
    expect(sa.secrets.map((s) => s.id)).toEqual([t.s2.id]);
  });

  it('not_narrower: anything wider is rejected and nothing is written', async () => {
    const t = await setup();
    const p = t.propose({ afterExpiry: 'renew', renewDays: 5 });
    const base = p.proposal;
    const wider: StandingProposal[] = [
      { ...base, days: 8 },
      { ...base, secretIds: [...base.secretIds, t.s3.id] },
      { ...base, scope: 'vaults', vaultIds: [t.team.id], secretIds: [] },
      { ...base, renewDays: 6 },
    ];
    for (const s of wider) expectHttp(() => t.decide(p.id, 'approve', s), 400, 'not_narrower');
    expect(getStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id).standingApproval).toBeNull();
    expect(getStandingRequestDto(t.w.ctx, p.id).status).toBe('pending');
    // ask → renew is wider too.
    const t2 = await setup();
    const q = t2.propose();
    expectHttp(() => t2.decide(q.id, 'approve', { ...q.proposal, afterExpiry: 'renew', renewDays: 1 }), 400, 'not_narrower');
    expectHttp(() => t2.decide(q.id, 'approve', { ...q.proposal, secretIds: [] }), 400, 'empty_list');
  });

  it('unavailable items are dropped on approval (diff); nothing left → 409 items_unavailable', async () => {
    const t = await setup();
    const p = t.propose();
    archiveSecret(t.w.ctx, t.w.alice.actor, t.s1.id, { reason: "gone" });
    expect(getStandingRequestDto(t.w.ctx, p.id).items.secrets.map((s) => s.available)).toEqual([false, true]);
    expectHttp(() => t.decide(p.id, 'approve', { ...p.proposal, secretIds: [t.s1.id] }), 409, 'items_unavailable');
    const dto = t.decide(p.id, 'approve');
    expect(dto.final!.secretIds).toEqual([t.s2.id]);
    expect(dto.adjusted).toBe(true);
  });

  it('vaults scope approval covers the vault', async () => {
    const t = await setup();
    const teamSecret = createSecret(t.w.ctx, t.w.alice.actor, { title: 'T', value: 't', vaultId: t.team.id });
    const p = t.propose({ scope: 'vaults', vaultIds: [t.team.id], secretIds: [] });
    expect(p.items.vaults).toEqual([{ id: t.team.id, name: 'Team', personal: false, available: true }]);
    t.decide(p.id, 'approve');
    const r = createRequest(t.w.ctx, { device: t.dev, secretId: teamSecret.id, project: 'p', reason: 'r', delivery: 'cli' });
    expect(r.autoSource).toBe('standing');
  });

  it('deny: audit, no standing approval; only the owner may decide (404)', async () => {
    const t = await setup();
    const p = t.propose();
    expectHttp(() => decideStandingRequest(t.w.ctx, { id: p.id, userId: t.w.bob.id, decision: 'deny' }), 404, 'not_found');
    expectHttp(() => decideStandingRequest(t.w.ctx, { id: 'srq_nope', userId: t.w.alice.id, decision: 'deny' }), 404, 'not_found');
    const dto = t.decide(p.id, 'deny');
    expect(dto).toMatchObject({ status: 'denied', decidedBy: 'alice', final: null, adjusted: false });
    expect(meta(auditRows(t.w.db, 'standing_request.denied')[0])).toMatchObject({ requestId: p.id, via: 'web' });
    expect(getStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id).standingApproval).toBeNull();
  });

  it('approving while a standing approval is active cancels the proposal (superseded)', async () => {
    const t = await setup();
    const p = t.propose();
    // Written directly (bypassing setStandingApproval, which would cancel the proposal itself).
    t.w.db.$client
      .prepare(
        `INSERT INTO standing_approvals (device_id, user_id, until, granted_at, scope, include_created, allow_updates, after_expiry,
           renew_days, expiry_audited, created_at, updated_at) VALUES (?, ?, ?, ?, 'all', 0, 0, 'ask', 7, 0, ?, ?)`,
      )
      .run(t.dev.id, t.w.alice.id, t.w.clock.now() + DAY, t.w.clock.now(), t.w.clock.now(), t.w.clock.now());
    expectHttp(() => t.decide(p.id, 'approve'), 409, 'standing_active');
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'superseded' });
  });

  it('expired proposals: 410 on decide; sweep marks them expired with audit + event', async () => {
    const t = await setup();
    const p = t.propose();
    t.w.clock.advance(30 * MIN);
    expectHttp(() => t.decide(p.id, 'approve'), 410, 'expired');
    expect(listStandingRequests(t.w.ctx, t.w.alice.id, 'pending')).toEqual([]);
    t.events.length = 0;
    expireDue(t.w.ctx);
    expect(getStandingRequestDto(t.w.ctx, p.id).status).toBe('expired');
    expect(auditRows(t.w.db, 'standing_request.expired')).toHaveLength(1);
    expect(t.events.find((e) => e.type === 'standing_request.updated')).toBeTruthy();
    expectHttp(() => t.decide(p.id, 'deny'), 410, 'expired');
  });
});

describe('cancellation', () => {
  it('on device revocation (device_revoked)', async () => {
    const t = await setup();
    const p = t.propose();
    revokeDevice(t.w.ctx, t.dev.id, { type: 'user', userId: t.w.alice.id });
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'device_revoked' });
    expect(meta(auditRows(t.w.db, 'standing_request.cancelled')[0])).toEqual({ requestId: p.id, cause: 'device_revoked' });
    await tick();
    expect(t.events.some((e) => e.type === 'standing_request.updated' && e.data.status === 'cancelled')).toBe(true);
  });

  it('on a manual standing approval (superseded)', async () => {
    const t = await setup();
    const p = t.propose();
    setStandingApproval(t.w.ctx, t.w.alice.id, t.dev.id, StandingApprovalInputSchema.parse({ until: t.w.clock.now() + DAY, scope: 'all' }));
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'superseded' });
  });

  it('by the sweep while proposals are disabled (disabled_by_admin)', async () => {
    const t = await setup();
    const p = t.propose();
    expireDue({ ...t.w.ctx, standingRequestMaxDays: 0 });
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'disabled_by_admin' });
  });

  it('at startup when proposals are disabled', async () => {
    const t = await createTestApp({ config: { standingRequestMaxDays: 0 } });
    const u = await createUser(t.db, t.clock, { username: 'carol', password: 'correct horse battery', isAdmin: true });
    const { deviceId } = pairDevice(t.ctx, { userId: u.id, kind: 'mcp' });
    t.db.$client
      .prepare(
        `INSERT INTO standing_requests (id, user_id, device_id, scope, secret_ids, days, project, reason, created_at, expires_at)
         VALUES ('srq_1', ?, ?, 'list', '["sec_x"]', 3, 'p', 'r', ?, ?)`,
      )
      .run(u.id, deviceId, t.clock.now(), t.clock.now() + 30 * MIN);
    await t.app.ready();
    expect(getStandingRequestDto(t.ctx, 'srq_1')).toMatchObject({ status: 'cancelled', cause: 'disabled_by_admin' });
    await t.app.close();
  });

  it('approving for a revoked device cancels it (409 device_inactive)', async () => {
    const t = await setup();
    const p = t.propose();
    t.w.db.$client.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(t.dev.id);
    expectHttp(() => t.decide(p.id, 'approve'), 409, 'device_inactive');
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'device_revoked' });
  });

  it('approving while proposals are disabled cancels it (403)', async () => {
    const t = await setup();
    const p = t.propose();
    expectHttp(
      () => decideStandingRequest({ ...t.w.ctx, standingRequestMaxDays: 0 }, { id: p.id, userId: t.w.alice.id, decision: 'approve' }),
      403, 'standing_requests_disabled',
    );
    expect(getStandingRequestDto(t.w.ctx, p.id)).toMatchObject({ status: 'cancelled', cause: 'disabled_by_admin' });
  });
});

describe('waitForStandingRequest', () => {
  it('resolves on the decision; only the proposing device may wait; times out with the current state', async () => {
    const t = await setup();
    const p = t.propose();
    const other = pairDevice(t.w.ctx, { userId: t.w.alice.id, kind: 'mcp' });
    await expect(waitForStandingRequest(t.w.ctx, p.id, other.deviceId, 100)).rejects.toMatchObject({ code: 'not_found' });
    expect((await waitForStandingRequest(t.w.ctx, p.id, t.dev.id, 20)).status).toBe('pending');
    const waiting = waitForStandingRequest(t.w.ctx, p.id, t.dev.id, 5_000);
    t.decide(p.id, 'deny');
    expect((await waiting).status).toBe('denied');
    expect((await waitForStandingRequest(t.w.ctx, p.id, t.dev.id, 5_000)).status).toBe('denied');
  });
});

describe('standingRequestDiff', () => {
  it('is empty when unchanged', () => {
    const p: StandingProposal = { scope: 'vaults', vaultIds: ['a', 'b'], secretIds: [], days: 3, afterExpiry: 'ask', renewDays: null };
    expect(standingRequestDiff(p, p)).toEqual({});
    expect(standingRequestDiff(p, { ...p, vaultIds: ['b'] })).toEqual({ removedVaultIds: ['a'] });
  });
});

describe('HTTP /api/standing-requests', () => {
  it('lists pending / all for the owner only', async () => {
    const t = await setup();
    const p = t.propose();
    const list = (status: string, user = t.w.alice) => t.w.req(user, 'GET', `/api/standing-requests?status=${status}`);
    expect((await list('pending')).json().items.map((r: { id: string }) => r.id)).toEqual([p.id]);
    expect((await list('pending', t.w.bob)).json()).toEqual({ items: [] });
    t.decide(p.id, 'deny');
    expect((await list('pending')).json()).toEqual({ items: [] });
    expect((await list('all')).json().items).toHaveLength(1);
    expect((await t.w.req(undefined, 'GET', '/api/standing-requests')).statusCode).toBe(401);
  });

  it('approve needs a recent login; deny does not', async () => {
    const t = await setup();
    const p = t.propose();
    t.w.clock.advance(10 * MIN + 1);
    const stale = await t.decideHttp(p.id, { decision: 'approve' });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    expect(getStandingRequestDto(t.w.ctx, p.id).status).toBe('pending');
    const denied = await t.decideHttp(p.id, { decision: 'deny' });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ status: 'denied' });
  });

  it('approve with narrowed settings when recently signed in; error bodies carry codes', async () => {
    const t = await setup();
    const p = t.propose();
    const wider = await t.decideHttp(p.id, { decision: 'approve', settings: { ...p.proposal, days: 30 } });
    expect(wider.statusCode).toBe(400);
    expect(wider.json()).toEqual({ error: 'not_narrower' });
    const bad = await t.decideHttp(p.id, { decision: 'approve', settings: { ...p.proposal, allowUpdates: true } });
    expect(bad.json()).toEqual({ error: 'invalid_request' });
    const ok = await t.decideHttp(p.id, { decision: 'approve', settings: { ...p.proposal, days: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'approved', adjusted: true, final: { days: 2 } });
    expect(meta(auditRows(t.w.db, 'standing_request.approved')[0])).toMatchObject({ via: 'web' });
    const bob = await t.decideHttp(p.id, { decision: 'deny' }, t.w.bob.cookie);
    expect(bob.statusCode).toBe(404);
  });
});
