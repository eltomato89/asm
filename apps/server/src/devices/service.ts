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
import { deleteForRevokedDevice, deleteStandingForDevice, emitDeviceChanged, standingSummariesForUser, standingSummaryForDevice } from '../standing/service.js';

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
 * 404 not_found (not own device) | 404 vault_not_found | 409 device_inactive | 409 device_linked (attached CLI). Audit device.default_vault_changed, device.changed.
 */
export function setDeviceDefaultVault(
  ctx: ServiceCtx, userId: string, deviceId: string, vaultId: string | null, info: RequestInfo = {},
): DeviceDto {
  const { db } = ctx;
  const dev = db.select({ status: devices.status, linkedTo: devices.linkedToDeviceId }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId))).get();
  if (!dev) throw new HttpError(404, 'not_found');
  if (vaultId !== null && !canAccessVault(db, userId, vaultId)) throw new HttpError(404, 'vault_not_found');
  if (dev.status !== 'approved') throw new HttpError(409, 'device_inactive');
  if (dev.linkedTo !== null) throw new HttpError(409, 'device_linked');
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

export type LinkCause = 'manual' | 'activation';

/** A CLI leaves its group (unlink / relink): delete its outstanding grants, deny its open requests. In the caller's transaction. */
function dropInFlight(ctx: ServiceCtx, cliId: string): void {
  deleteGrantsForDevice(ctx.db, cliId);
  cancelOpenForDevice(ctx, cliId, 'device_link_changed');
}

/**
 * Link core (runs in the caller's transaction, does not emit). Attaches the approved CLI `cliId` of `userId` to the approved
 * 'mcp' device `mainId` of the same user. Drops the CLI's own standing approval and default vault (audit cause device_linked).
 * On a relink (attached to another main before) the CLI's outstanding grants are deleted and its open requests denied
 * (cause device_link_changed): they belong to the group it leaves.
 * 404 not_found (CLI not own) | 400 invalid_link (self, wrong kinds) | 404 main_not_found | 409 device_inactive.
 * Returns the devices whose view changed (empty when already linked to `mainId`).
 */
export function linkInTxn(
  ctx: ServiceCtx, userId: string, cliId: string, mainId: string, info: RequestInfo, cause: LinkCause,
): string[] {
  const { db, clock } = ctx;
  const cli = db
    .select({ kind: devices.kind, status: devices.status, linkedTo: devices.linkedToDeviceId, defaultVaultId: devices.defaultVaultId })
    .from(devices).where(and(eq(devices.id, cliId), eq(devices.userId, userId))).get();
  if (!cli) throw new HttpError(404, 'not_found');
  if (cliId === mainId) throw new HttpError(400, 'invalid_link');
  const main = db.select({ kind: devices.kind, status: devices.status }).from(devices)
    .where(and(eq(devices.id, mainId), eq(devices.userId, userId))).get();
  if (!main || main.status !== 'approved') throw new HttpError(404, 'main_not_found');
  if (cli.kind !== 'cli' || main.kind !== 'mcp') throw new HttpError(400, 'invalid_link');
  if (cli.status !== 'approved') throw new HttpError(409, 'device_inactive');
  if (cli.linkedTo === mainId) return [];

  if (cli.linkedTo !== null) dropInFlight(ctx, cliId);
  const droppedStanding = deleteStandingForDevice(ctx, cliId, 'device_linked', userId);
  db.update(devices).set({ linkedToDeviceId: mainId, defaultVaultId: null }).where(eq(devices.id, cliId)).run();
  if (cli.defaultVaultId !== null) {
    appendAudit(db, clock, {
      actorType: 'user', actorId: userId, event: 'device.default_vault_changed', deviceId: cliId,
      vaultId: deviceDefaultVault(db, cliId)?.id ?? null, ip: info.ip ?? null,
      meta: { previousVaultId: cli.defaultVaultId, vaultId: null, cause: 'device_linked' },
    });
  }
  appendAudit(db, clock, {
    actorType: 'user', actorId: userId, event: 'device.linked', deviceId: cliId, ip: info.ip ?? null,
    meta: {
      mainDeviceId: mainId,
      ...(cli.linkedTo !== null ? { previousMainDeviceId: cli.linkedTo } : {}),
      cause, droppedStanding, previousDefaultVaultId: cli.defaultVaultId,
    },
  });
  return cli.linkedTo !== null ? [cliId, mainId, cli.linkedTo] : [cliId, mainId];
}

/**
 * Attaches an own approved CLI to an own approved 'mcp' main device (relinking allowed, idempotent for the same main).
 * Callers (routes) must require recent auth. Errors see linkInTxn. Audit device.linked; device.changed for CLI and main(s).
 */
export function linkDevice(
  ctx: ServiceCtx, userId: string, cliId: string, mainId: string, info: RequestInfo = {}, cause: LinkCause = 'manual',
): DeviceDto {
  const changed = ctx.db.$client.transaction(() => linkInTxn(ctx, userId, cliId, mainId, info, cause))();
  for (const id of changed) emitDeviceChanged(ctx, userId, id);
  return getOwnDevice(ctx, userId, cliId);
}

/**
 * Detaches a CLI from its main device; it starts with empty settings. Its outstanding grants are deleted and its open requests
 * denied (cause device_link_changed). Idempotent. 404 not_found (not own device).
 * Audit device.unlinked (cause manual); device.changed for CLI and main.
 */
export function unlinkDevice(ctx: ServiceCtx, userId: string, cliId: string, info: RequestInfo = {}): DeviceDto {
  const { db, clock } = ctx;
  const mainId = db.$client.transaction((): string | null => {
    const cli = db.select({ linkedTo: devices.linkedToDeviceId }).from(devices)
      .where(and(eq(devices.id, cliId), eq(devices.userId, userId))).get();
    if (!cli) throw new HttpError(404, 'not_found');
    if (cli.linkedTo === null) return null;
    db.update(devices).set({ linkedToDeviceId: null }).where(eq(devices.id, cliId)).run();
    dropInFlight(ctx, cliId);
    appendAudit(db, clock, {
      actorType: 'user', actorId: userId, event: 'device.unlinked', deviceId: cliId, ip: info.ip ?? null,
      meta: { mainDeviceId: cli.linkedTo, cause: 'manual' },
    });
    return cli.linkedTo;
  })();
  if (mainId) {
    emitDeviceChanged(ctx, userId, cliId);
    emitDeviceChanged(ctx, userId, mainId);
  }
  return getOwnDevice(ctx, userId, cliId);
}

export type RevokeActor = { type: 'user'; userId: string } | { type: 'system'; cause: string };
export type AttachedOnRevoke = 'revoke' | 'detach';

const actorFields = (actor: RevokeActor) =>
  actor.type === 'user' ? { actorType: 'user' as const, actorId: actor.userId } : { actorType: 'system' as const, actorId: null };

/**
 * Revocation core (runs in the caller's transaction, does not emit). Collects the owner's affected device ids in `affected`.
 * `cause` overrides the audit meta cause (used for attached CLIs revoked with their main device).
 */
function revokeInTxn(
  ctx: ServiceCtx, deviceId: string, actor: RevokeActor, info: RequestInfo, attached: AttachedOnRevoke,
  affected: Map<string, string>, cause?: string,
): void {
  const { db, clock } = ctx;
  const dev = db.select({ status: devices.status, userId: devices.userId, linkedTo: devices.linkedToDeviceId })
    .from(devices).where(eq(devices.id, deviceId)).get();
  if (!dev || dev.status === 'revoked') return;
  const now = clock.now();
  db.update(devices).set({ status: 'revoked', linkedToDeviceId: null }).where(eq(devices.id, deviceId)).run();
  db.update(tokens).set({ revokedAt: now }).where(and(eq(tokens.deviceId, deviceId), isNull(tokens.revokedAt))).run();
  db.delete(oauthCodes).where(eq(oauthCodes.deviceId, deviceId)).run();
  db.delete(deviceCodes).where(eq(deviceCodes.deviceId, deviceId)).run();
  deleteGrantsForDevice(db, deviceId);
  cancelOpenForDevice(ctx, deviceId);
  const hadStanding = deleteForRevokedDevice(ctx, deviceId);
  const metaCause = cause ?? (actor.type === 'system' ? actor.cause : undefined);
  appendAudit(db, clock, {
    ...actorFields(actor),
    event: 'device.revoked',
    deviceId,
    ip: info.ip ?? null,
    ...(metaCause !== undefined ? { meta: { cause: metaCause } } : {}),
  });
  const owner = dev.userId;
  const touch = (id: string) => { if (owner) affected.set(id, owner); };
  if (hadStanding) touch(deviceId);
  if (dev.linkedTo !== null) {
    touch(deviceId);
    touch(dev.linkedTo);
  }
  const clis = db.select({ id: devices.id }).from(devices).where(eq(devices.linkedToDeviceId, deviceId)).all();
  for (const c of clis) {
    touch(deviceId);
    touch(c.id);
    if (attached === 'revoke') {
      revokeInTxn(ctx, c.id, actor, info, 'detach', affected, 'main_revoked');
    } else {
      db.update(devices).set({ linkedToDeviceId: null }).where(eq(devices.id, c.id)).run();
      dropInFlight(ctx, c.id);
      appendAudit(db, clock, {
        ...actorFields(actor), event: 'device.unlinked', deviceId: c.id, ip: info.ip ?? null,
        meta: { mainDeviceId: deviceId, cause: 'main_revoked' },
      });
    }
  }
}

/**
 * Revokes a device: status `revoked`, link cleared, all its tokens revoked, outstanding codes and grants deleted, its open
 * requests denied by the system (cause `device_inactive`, emitted after commit), its standing approval deleted (cause
 * `device_revoked`), audit `device.revoked`. CLIs attached to it are revoked too (`attached` 'revoke', audit meta.cause
 * `main_revoked`) or detached ('detach', audit device.unlinked cause `main_revoked`, their grants deleted and open requests
 * denied); default: 'revoke' for a user actor, 'detach' for the system (e.g. refresh-token reuse). One transaction; then `device.changed` for every affected device.
 * Idempotent: an already revoked device is not audited again.
 */
export function revokeDevice(
  ctx: ServiceCtx, deviceId: string, actor: RevokeActor, info: RequestInfo = {}, opts: { attached?: AttachedOnRevoke } = {},
): void {
  const attached = opts.attached ?? (actor.type === 'user' ? 'revoke' : 'detach');
  const affected = new Map<string, string>();
  ctx.db.$client.transaction(() => revokeInTxn(ctx, deviceId, actor, info, attached, affected))();
  for (const [id, owner] of affected) emitDeviceChanged(ctx, owner, id);
}

export function revokeOwnDevice(
  ctx: ServiceCtx, userId: string, deviceId: string, info: RequestInfo, opts: { attached?: AttachedOnRevoke } = {},
): DeviceDto {
  getOwnDevice(ctx, userId, deviceId);
  revokeDevice(ctx, deviceId, { type: 'user', userId }, info, opts);
  return getOwnDevice(ctx, userId, deviceId);
}
