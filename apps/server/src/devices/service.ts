import { newId } from '@asm/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { appendAudit } from '../audit/audit.js';
import { deleteGrantsForDevice } from '../requests/grants.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import { deviceCodes, devices, oauthCodes, tokens } from '../db/schema.js';
import { HttpError } from '../errors.js';

export type DeviceKind = 'mcp' | 'cli';
export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'revoked';

/** Public device view: never contains token material. */
export type DeviceDto = {
  id: string;
  name: string;
  kind: DeviceKind;
  hostname: string | null;
  status: DeviceStatus;
  lastUsedAt: number | null;
  createdAt: number;
};

const dtoColumns = {
  id: devices.id,
  name: devices.name,
  kind: devices.kind,
  hostname: devices.hostname,
  status: devices.status,
  lastUsedAt: devices.lastUsedAt,
  createdAt: devices.createdAt,
};

export function createDevice(
  ctx: ServiceCtx,
  d: { userId: string | null; name: string; kind: DeviceKind; status: DeviceStatus; hostname?: string | null },
): string {
  const id = newId('dev');
  ctx.db
    .insert(devices)
    .values({ id, userId: d.userId, name: d.name, kind: d.kind, status: d.status, hostname: d.hostname ?? null, createdAt: ctx.clock.now() })
    .run();
  return id;
}

export function listDevices(db: Db, userId: string): DeviceDto[] {
  return db.select(dtoColumns).from(devices).where(eq(devices.userId, userId)).orderBy(devices.createdAt, devices.id).all();
}

function getOwnDevice(db: Db, userId: string, deviceId: string): DeviceDto {
  const row = db.select(dtoColumns).from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId))).get();
  if (!row) throw new HttpError(404, 'not_found');
  return row;
}

export function renameDevice(ctx: ServiceCtx, userId: string, deviceId: string, name: string): DeviceDto {
  getOwnDevice(ctx.db, userId, deviceId);
  ctx.db.update(devices).set({ name }).where(eq(devices.id, deviceId)).run();
  return getOwnDevice(ctx.db, userId, deviceId);
}

export type RevokeActor = { type: 'user'; userId: string } | { type: 'system'; cause: string };

/**
 * Revokes a device: status `revoked`, all its tokens revoked, outstanding codes deleted, audit `device.revoked`.
 * Idempotent: an already revoked device is not audited again.
 */
export function revokeDevice(ctx: ServiceCtx, deviceId: string, actor: RevokeActor, info: RequestInfo = {}): void {
  const { db, clock } = ctx;
  db.$client.transaction(() => {
    const dev = db.select({ status: devices.status }).from(devices).where(eq(devices.id, deviceId)).get();
    if (!dev || dev.status === 'revoked') return;
    const now = clock.now();
    db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, deviceId)).run();
    db.update(tokens).set({ revokedAt: now }).where(and(eq(tokens.deviceId, deviceId), isNull(tokens.revokedAt))).run();
    db.delete(oauthCodes).where(eq(oauthCodes.deviceId, deviceId)).run();
    db.delete(deviceCodes).where(eq(deviceCodes.deviceId, deviceId)).run();
    deleteGrantsForDevice(db, deviceId);
    appendAudit(db, clock, {
      ...(actor.type === 'user'
        ? { actorType: 'user', actorId: actor.userId }
        : { actorType: 'system', actorId: null, meta: { cause: actor.cause } }),
      event: 'device.revoked',
      deviceId,
      ip: info.ip ?? null,
    });
  })();
}

export function revokeOwnDevice(ctx: ServiceCtx, userId: string, deviceId: string, info: RequestInfo): DeviceDto {
  getOwnDevice(ctx.db, userId, deviceId);
  revokeDevice(ctx, deviceId, { type: 'user', userId }, info);
  return getOwnDevice(ctx.db, userId, deviceId);
}
