import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoModeDtoSchema } from '@asm/shared';
import { FakeClock } from '../src/clock.js';
import { HttpError, ValidationError } from '../src/errors.js';
import type { DeviceIdentity } from '../src/oauth/bearer.js';
import { disableAutoMode, enableAutoMode, getAutoMode } from '../src/requests/automode.js';
import { grantIdForRequest } from '../src/requests/grants.js';
import { createRequest, expireDue } from '../src/requests/service.js';
import { createSecret } from '../src/secrets/service.js';
import { createVault } from '../src/vaults/service.js';
import { ORIGIN, addUser, auditRows, pairDevice, world } from './helpers/fixtures.js';
import { createTestApp } from './helpers/testApp.js';

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const w = await world();
  const secret = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Key', value: 'sk' });
  const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
  const dev: DeviceIdentity = { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' };
  const read = (secretId = secret.id) => createRequest(w.ctx, { device: dev, secretId, project: 'p', reason: 'r', delivery: 'cli' });
  return { w, secret, dev, read };
}

describe('auto mode', () => {
  it('30 min on -> request approved immediately with auto=true and a grant; at now == enabled_until -> pending', async () => {
    const { w, secret, dev, read } = await setup();
    expect(getAutoMode(w.ctx, w.alice.id)).toEqual({ active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null });
    const am = enableAutoMode(w.ctx, w.alice.id, 30);
    AutoModeDtoSchema.parse(am);
    expect(am).toEqual({ active: true, enabledUntil: w.clock.now() + 30 * MIN, defaultDurationMin: 30, vaultIds: null });
    expect(auditRows(w.db, 'automode.enabled')[0]).toMatchObject({ actor_type: 'user', actor_id: w.alice.id });

    const r = read();
    expect(r).toMatchObject({ status: 'approved', auto: true, decidedBy: null });
    expect(grantIdForRequest(w.db, r.id, dev.id)).not.toBeNull();
    expect(auditRows(w.db, 'request.auto_approved')[0]).toMatchObject({ actor_type: 'system', secret_id: secret.id, vault_id: secret.vaultId });
    expect(auditRows(w.db, 'request.created')).toHaveLength(0);
    expect(w.db.$client.prepare('SELECT count(*) AS n FROM project_usage').get()).toEqual({ n: 1 });

    w.clock.advance(30 * MIN - 1);
    expect(read().status).toBe('approved');
    w.clock.advance(1);
    expect(read().status).toBe('pending');
    expect(getAutoMode(w.ctx, w.alice.id).active).toBe(false);
  });

  it('expireDue turns an elapsed auto mode off and audits automode.disabled (cause expired)', async () => {
    const { w } = await setup();
    enableAutoMode(w.ctx, w.alice.id, 10);
    const seen: unknown[] = [];
    w.ctx.events.subscribe(w.alice.id, (e) => seen.push(e));
    w.clock.advance(10 * MIN);
    expireDue(w.ctx);
    expect(w.db.$client.prepare('SELECT enabled_until FROM auto_mode').get()).toEqual({ enabled_until: null });
    const row = auditRows(w.db, 'automode.disabled')[0]!;
    expect(JSON.parse(String(row.meta))).toMatchObject({ cause: 'expired' });
    expect(seen).toEqual([{ type: 'automode.changed', data: expect.objectContaining({ active: false }) }]);
    expireDue(w.ctx);
    expect(auditRows(w.db, 'automode.disabled')).toHaveLength(1);
  });

  it('limited to vault X -> request from vault Y stays pending', async () => {
    const { w, read } = await setup();
    const x = createVault(w.ctx, w.alice.id, 'X');
    const y = createVault(w.ctx, w.alice.id, 'Y');
    const sx = createSecret(w.ctx, w.alice.actor, { vaultId: x.id, title: 'in x', value: '1' });
    const sy = createSecret(w.ctx, w.alice.actor, { vaultId: y.id, title: 'in y', value: '2' });
    expect(enableAutoMode(w.ctx, w.alice.id, 30, [x.id]).vaultIds).toEqual([x.id]);
    expect(read(sx.id).status).toBe('approved');
    expect(read(sy.id).status).toBe('pending');
  });

  it('validation: minutes 1..autoModeMaxMin, vaults must be accessible', async () => {
    const { w } = await setup();
    await rejects(() => enableAutoMode(w.ctx, w.alice.id, 0), 400);
    await rejects(() => enableAutoMode(w.ctx, w.alice.id, 241), 400);
    await rejects(() => enableAutoMode(w.ctx, w.alice.id, 1.5), 400);
    expect(enableAutoMode(w.ctx, w.alice.id, 240).active).toBe(true);
    await rejects(() => enableAutoMode(w.ctx, w.alice.id, 30, [w.bob.personalVaultId]), 404);
    await rejects(() => enableAutoMode(w.ctx, w.alice.id, 30, []), 400);
  });

  it('routes: PUT needs recent auth, > max -> 400, GET/DELETE', async () => {
    const { w } = await setup();
    const put = (body: unknown) =>
      w.app.inject({ method: 'PUT', url: '/api/automode', headers: { cookie: w.alice.cookie, origin: ORIGIN }, payload: body as Record<string, unknown> });
    expect((await put({ minutes: 241 })).statusCode).toBe(400);
    const ok = await put({ minutes: 45 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ active: true, defaultDurationMin: 45 });
    expect((await w.req(w.alice, 'GET', '/api/automode')).json()).toMatchObject({ active: true, enabledUntil: w.clock.now() + 45 * MIN });
    const del = await w.req(w.alice, 'DELETE', '/api/automode');
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ active: false, enabledUntil: null });
    expect(JSON.parse(String(auditRows(w.db, 'automode.disabled')[0]!.meta))).toMatchObject({ cause: 'manual' });
    expect((await w.req(w.bob, 'GET', '/api/automode')).json()).toMatchObject({ active: false });
    w.clock.advance(11 * MIN);
    expect((await put({ minutes: 30 })).statusCode).toBe(401);
    expect((await w.req(undefined, 'GET', '/api/automode')).statusCode).toBe(401);
    disableAutoMode(w.ctx, w.alice.id);
  });

  it('survives a new buildApp on the same DB file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asm-am-'));
    dirs.push(dir);
    const dbPath = join(dir, 'asm.db');
    const clock = new FakeClock();
    const first = await createTestApp({ dbPath, clock });
    const alice = await addUser(first, 'alice');
    enableAutoMode(first.ctx, alice.id, 30);
    await first.app.close();
    first.db.$client.close();

    clock.advance(10 * MIN);
    const second = await createTestApp({ dbPath, clock });
    expect(getAutoMode(second.ctx, alice.id).active).toBe(true);
    const secret = createSecret(second.ctx, alice.actor, { title: 's', value: 'v' });
    const { deviceId } = pairDevice(second.ctx, { userId: alice.id, kind: 'mcp' });
    const r = createRequest(second.ctx, {
      device: { id: deviceId, userId: alice.id, kind: 'mcp', name: 'test-mcp' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli',
    });
    expect(r).toMatchObject({ status: 'approved', auto: true });
    await second.app.close();
    second.db.$client.close();
  });
});
