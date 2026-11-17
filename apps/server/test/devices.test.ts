import { describe, expect, it } from 'vitest';
import { DeviceDtoSchema, newId } from '@asm/shared';
import { devices } from '../src/db/schema.js';
import { issueTokens } from '../src/oauth/token.js';
import { addBearerProbe, allKeys, auditRows, bearer, pairDevice, world } from './helpers/fixtures.js';

async function setup() {
  return world({ beforeReady: addBearerProbe });
}

describe('devices API', () => {
  it('lists only own devices and never token data', async () => {
    const w = await setup();
    const a = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'Claude Laptop' });
    pairDevice(w.ctx, { userId: w.bob.id, kind: 'cli' });
    const res = await w.req(w.alice, 'GET', '/api/devices');
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toEqual([
      {
        id: a.deviceId, name: 'Claude Laptop', kind: 'mcp', hostname: null, status: 'approved', lastUsedAt: null, createdAt: w.clock.now(),
        standingApproval: null,
      },
    ]);
    for (const it of items) DeviceDtoSchema.parse(it);
    const keys = allKeys(res.json());
    for (const k of ['token', 'tokenHash', 'token_hash', 'accessToken', 'refreshToken']) expect(keys.has(k)).toBe(false);
    expect(res.body).not.toContain(a.accessToken);
    expect((await w.req(undefined, 'GET', '/api/devices')).statusCode).toBe(401);
  });

  it('renames own devices; other users get 404; name validated', async () => {
    const w = await setup();
    const a = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp' });
    const ok = await w.req(w.alice, 'PATCH', `/api/devices/${a.deviceId}`, { name: '  Arbeits-Laptop ' });
    expect(ok.statusCode).toBe(200);
    expect(DeviceDtoSchema.parse(ok.json())).toMatchObject({ id: a.deviceId, name: 'Arbeits-Laptop' });
    expect((await w.req(w.bob, 'PATCH', `/api/devices/${a.deviceId}`, { name: 'x' })).statusCode).toBe(404);
    expect((await w.req(w.alice, 'PATCH', `/api/devices/${a.deviceId}`, { name: '' })).statusCode).toBe(400);
    expect((await w.req(w.alice, 'PATCH', `/api/devices/${a.deviceId}`, { name: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await w.req(w.alice, 'PATCH', '/api/devices/dev_nope', { name: 'x' })).statusCode).toBe(404);
  });

  it('revoking a device makes a valid access token fail immediately', async () => {
    const w = await setup();
    const a = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp' });
    expect((await bearer(w.app, a.accessToken)).statusCode).toBe(200);
    expect((await w.req(w.bob, 'POST', `/api/devices/${a.deviceId}/revoke`)).statusCode).toBe(404);
    const res = await w.req(w.alice, 'POST', `/api/devices/${a.deviceId}/revoke`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.deviceId, status: 'revoked' });
    const after = await bearer(w.app, a.accessToken);
    expect(after.statusCode).toBe(401);
    expect(after.headers['www-authenticate']).toContain('resource_metadata="https://asm.test/.well-known/oauth-protected-resource"');
    expect(w.db.$client.prepare('SELECT count(*) AS n FROM tokens WHERE device_id = ? AND revoked_at IS NULL').get(a.deviceId)).toEqual({ n: 0 });
    const refresh = await w.app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: a.refreshToken } });
    expect(refresh.json().error).toBe('invalid_grant');
    const rev = auditRows(w.db, 'device.revoked');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ actor_type: 'user', actor_id: w.alice.id, device_id: a.deviceId });
  });

  it('revoke requires recent auth', async () => {
    const w = await setup();
    const a = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli' });
    w.clock.advance(10 * 60_000 + 1);
    const res = await w.req(w.alice, 'POST', `/api/devices/${a.deviceId}/revoke`);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'reauth_required' });
  });
});

describe('bearerAuth', () => {
  it('rejects tokens of devices that are not approved', async () => {
    const w = await setup();
    const id = newId('dev');
    w.db.insert(devices).values({ id, userId: w.alice.id, name: 'p', kind: 'cli', status: 'pending', createdAt: 0 }).run();
    const t = issueTokens(w.ctx, id);
    const res = await bearer(w.app, t.accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('updates last_used_at', async () => {
    const w = await setup();
    const a = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp' });
    w.clock.advance(1234);
    expect((await bearer(w.app, a.accessToken)).statusCode).toBe(200);
    const items = (await w.req(w.alice, 'GET', '/api/devices')).json().items;
    expect(items[0].lastUsedAt).toBe(w.clock.now());
  });
});
