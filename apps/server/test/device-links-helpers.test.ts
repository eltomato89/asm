import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { devices } from '../src/db/schema.js';
import { listDevices } from '../src/devices/service.js';
import { attachedClis, isGroupRestricted, linkCandidates, sameGroup, settingsDeviceId } from '../src/devices/links.js';
import { pairDevice, world } from './helpers/fixtures.js';

async function setup() {
  const w = await world();
  const mainA = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'main-a' }).deviceId;
  const mainB = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'main-b' }).deviceId;
  const cli1 = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'cli-1' }).deviceId;
  const cli2 = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'cli-2' }).deviceId;
  const loose = pairDevice(w.ctx, { userId: w.alice.id, kind: 'cli', name: 'loose' }).deviceId;
  const bobMain = pairDevice(w.ctx, { userId: w.bob.id, kind: 'mcp', name: 'bob-main' }).deviceId;
  const link = (cli: string, main: string | null) => w.db.update(devices).set({ linkedToDeviceId: main }).where(eq(devices.id, cli)).run();
  link(cli1, mainA);
  link(cli2, mainA);
  return { ...w, mainA, mainB, cli1, cli2, loose, bobMain, link };
}

describe('device link helpers', () => {
  it('settingsDeviceId resolves attached CLIs to their main device', async () => {
    const w = await setup();
    expect(settingsDeviceId(w.db, w.cli1)).toBe(w.mainA);
    expect(settingsDeviceId(w.db, w.mainA)).toBe(w.mainA);
    expect(settingsDeviceId(w.db, w.loose)).toBe(w.loose);
    expect(settingsDeviceId(w.db, 'dev_missing')).toBe('dev_missing');
  });

  it('attachedClis lists only approved attached CLIs', async () => {
    const w = await setup();
    w.db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, w.cli2)).run();
    expect(attachedClis(w.db, w.mainA)).toEqual([{ id: w.cli1, name: 'cli-1', hostname: null, lastUsedAt: null }]);
    expect(attachedClis(w.db, w.mainB)).toEqual([]);
  });

  it('isGroupRestricted: attached CLI or main with approved CLIs', async () => {
    const w = await setup();
    expect(isGroupRestricted(w.db, w.cli1)).toBe(true);
    expect(isGroupRestricted(w.db, w.mainA)).toBe(true);
    expect(isGroupRestricted(w.db, w.mainB)).toBe(false);
    expect(isGroupRestricted(w.db, w.loose)).toBe(false);
    expect(isGroupRestricted(w.db, 'dev_missing')).toBe(false);
    w.db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, w.cli1)).run();
    w.db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, w.cli2)).run();
    expect(isGroupRestricted(w.db, w.mainA)).toBe(false);
  });

  it('sameGroup compares settings devices of existing rows', async () => {
    const w = await setup();
    expect(sameGroup(w.db, w.cli1, w.cli2)).toBe(true);
    expect(sameGroup(w.db, w.cli1, w.mainA)).toBe(true);
    expect(sameGroup(w.db, w.mainA, w.mainA)).toBe(true);
    expect(sameGroup(w.db, w.cli1, w.mainB)).toBe(false);
    expect(sameGroup(w.db, w.loose, w.mainA)).toBe(false);
    expect(sameGroup(w.db, 'dev_missing', 'dev_missing')).toBe(false);
  });

  it('linkCandidates lists the user’s approved mcp devices with attached counts', async () => {
    const w = await setup();
    w.db.update(devices).set({ lastUsedAt: 5 }).where(eq(devices.id, w.mainB)).run();
    const c = linkCandidates(w.db, w.alice.id);
    expect(c.map((x) => [x.id, x.attachedCount])).toEqual([[w.mainB, 0], [w.mainA, 2]]);
    expect(c[0]).toEqual({ id: w.mainB, name: 'main-b', lastUsedAt: 5, createdAt: expect.any(Number), attachedCount: 0 });
    expect(linkCandidates(w.db, w.bob.id).map((x) => x.id)).toEqual([w.bobMain]);
  });

  it('device DTO exposes linkedTo', async () => {
    const w = await setup();
    const byId = new Map(listDevices(w.ctx, w.alice.id).map((d) => [d.id, d]));
    expect(byId.get(w.cli1)?.linkedTo).toEqual({ id: w.mainA, name: 'main-a' });
    expect(byId.get(w.mainA)?.linkedTo).toBeNull();
    expect(byId.get(w.loose)?.linkedTo).toBeNull();
  });

  it('deleting the main device row detaches CLIs (ON DELETE SET NULL)', async () => {
    const w = await setup();
    w.db.$client.prepare('DELETE FROM tokens WHERE device_id = ?').run(w.mainA);
    w.db.delete(devices).where(eq(devices.id, w.mainA)).run();
    expect(settingsDeviceId(w.db, w.cli1)).toBe(w.cli1);
  });
});
