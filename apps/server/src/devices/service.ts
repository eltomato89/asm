import { newId, type DeviceDto } from '@asm/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { appendAudit } from '../audit/audit.js';
import { deleteGrantsForDevice } from '../requests/grants.js';
import { cancelOpenForDevice } from '../requests/service.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import { deviceCodes, devices, oauthCodes, tokens } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { canAccessVault, deviceDefaultVault, personalVaultId } from '../vaults/service.js';
import { deleteForRevokedDevice, emitDeviceChanged, standingSummariesForUser, standingSummaryForDevice } from '../standing/service.js';

export type DeviceKind = DeviceDto['kind'];
export type DeviceStatus = DeviceDto['status'];
/** Public device view (never contains token material), incl. a standing approval summary. */
export type { DeviceDto };

/** Self-join target for `linkedTo` (the main device an attached CLI belongs to). */
const mainDevice = alias(devices, 'main_device');

const dtoColumns = {
  id: devices.id,
  name: devices.name,
  kind: devices.kind,
  hostname: devices.hostname,
  status: devices.status,
  lastUsedAt: devices.lastUsedAt,
  createdAt: devices.createdAt,
  linkedId: mainDevice.id,
  linkedName: mainDevice.name,
};

function baseDto<R extends { linkedId: string | null; linkedName: string | null }>({ linkedId, linkedName, ...rest }: R) {
  return { ...rest, linkedTo: linkedId !== null && linkedName !== null ? { id: linkedId, name: linkedName } : null };
}

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

export function listDevices(ctx: ServiceCtx, userId: string): DeviceDto[] {
  const standing = standingSummariesForUser(ctx, userId);
  return ctx.db
    .select(dtoColumns)
    .from(devices)
    .leftJoin(mainDevice, eq(mainDevice.id, devices.linkedToDeviceId))
    .where(eq(devices.userId, userId))
    .orderBy(devices.createdAt, devices.id)
    .all()
    .map((d) => ({ ...baseDto(d), standingApproval: standing.get(d.id) ?? null, defaultVault: deviceDefaultVault(ctx.db, d.id) }));
}

function getOwnDevice(ctx: ServiceCtx, userId: string, deviceId: string): DeviceDto {
  const row = ctx.db
    .select(dtoColumns)
    .from(devices)
    .leftJoin(mainDevice, eq(mainDevice.id, devices.linkedToDeviceId))
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, 'not_found');
  return { ...baseDto(row), standingApproval: standingSummaryForDevice(ctx, deviceId), defaultVault: deviceDefaultVault(ctx.db, deviceId) };
}

export function renameDevice(ctx: ServiceCtx, userId: string, deviceId: string, name: string): DeviceDto {
  getOwnDevice(ctx, userId, deviceId);
  ctx.db.update(devices).set({ name }).where(eq(devices.id, deviceId)).run();
  return getOwnDevice(ctx, userId, deviceId);
}

/**
 * Sets the device's default vault (`vaultId` null = back to the owner's personal vault). Callers (routes) must require recent
 * auth: with an include_created standing approval it widens what gets auto-approved.
 * 404 not_found (not own device) | 404 vault_not_found | 409 device_inactive. Audit device.default_vault_changed, device.changed.
 */
export function setDeviceDefaultVault(
  ctx: ServiceCtx, userId: string, deviceId: string, vaultId: string | null, info: RequestInfo = {},
): DeviceDto {
  const { db } = ctx;
  const dev = db.select({ status: devices.status, defaultVaultId: devices.defaultVaultId }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId))).get();
  if (!dev) throw new HttpError(404, 'not_found');
  if (vaultId !== null && !canAccessVault(db, userId, vaultId)) throw new HttpError(404, 'vault_not_found');
  if (dev.status !== 'approved') throw new HttpError(409, 'device_inactive');
  // Storing the personal vault explicitly is the same as the default: keep NULL so it follows the owner's personal vault.
  const stored = vaultId !== null && vaultId === personalVaultId(db, userId) ? null : vaultId;
  const previous = deviceDefaultVault(db, deviceId);
  db.$client.transaction(() => {
    db.update(devices).set({ defaultVaultId: stored }).where(eq(devices.id, deviceId)).run();
    const next = deviceDefaultVault(db, deviceId);
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: userId, event: 'device.default_vault_changed', deviceId, vaultId: next?.id ?? null, ip: info.ip ?? null,
      meta: { previousVaultId: previous?.id ?? null, vaultId: stored },
    });
  })();
  emitDeviceChanged(ctx, userId, deviceId);
  return getOwnDevice(ctx, userId, deviceId);
}

export type RevokeActor = { type: 'user'; userId: string } | { type: 'system'; cause: string };

/**
 * Revokes a device: status `revoked`, all its tokens revoked, outstanding codes and grants deleted, its open requests
 * denied by the system (cause `device_inactive`, emitted after commit), its standing approval deleted (cause `device_revoked`),
 * audit `device.revoked`, then (if a standing approval was deleted) `device.changed` for the owner. Idempotent: an already revoked device is not audited again.
 */
export function revokeDevice(ctx: ServiceCtx, deviceId: string, actor: RevokeActor, info: RequestInfo = {}): void {
  const { db, clock } = ctx;
  const standingOwner = db.$client.transaction((): string | null => {
    const dev = db.select({ status: devices.status, userId: devices.userId }).from(devices).where(eq(devices.id, deviceId)).get();
    if (!dev || dev.status === 'revoked') return null;
    const now = clock.now();
    db.update(devices).set({ status: 'revoked' }).where(eq(devices.id, deviceId)).run();
    db.update(tokens).set({ revokedAt: now }).where(and(eq(tokens.deviceId, deviceId), isNull(tokens.revokedAt))).run();
    db.delete(oauthCodes).where(eq(oauthCodes.deviceId, deviceId)).run();
    db.delete(deviceCodes).where(eq(deviceCodes.deviceId, deviceId)).run();
    deleteGrantsForDevice(db, deviceId);
    cancelOpenForDevice(ctx, deviceId);
    const hadStanding = deleteForRevokedDevice(ctx, deviceId);
    appendAudit(db, clock, {
      ...(actor.type === 'user'
        ? { actorType: 'user', actorId: actor.userId }
        : { actorType: 'system', actorId: null, meta: { cause: actor.cause } }),
      event: 'device.revoked',
      deviceId,
      ip: info.ip ?? null,
    });
    return hadStanding ? dev.userId : null;
  })();
  if (standingOwner) emitDeviceChanged(ctx, standingOwner, deviceId);
}

export function revokeOwnDevice(ctx: ServiceCtx, userId: string, deviceId: string, info: RequestInfo): DeviceDto {
  getOwnDevice(ctx, userId, deviceId);
  revokeDevice(ctx, deviceId, { type: 'user', userId }, info);
  return getOwnDevice(ctx, userId, deviceId);
}
