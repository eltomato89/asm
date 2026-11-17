import { newId, type VaultDto } from '@asm/shared';
import { and, eq } from 'drizzle-orm';
import { appendAudit } from '../audit/audit.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import { users, vaultMembers, vaults } from '../db/schema.js';
import { HttpError, ValidationError } from '../errors.js';

export type VaultRole = 'owner' | 'member';

export function vaultRole(db: Db, userId: string, vaultId: string): VaultRole | null {
  const row = db
    .select({ role: vaultMembers.role })
    .from(vaultMembers)
    .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId)))
    .get();
  return row?.role ?? null;
}

export function canAccessVault(db: Db, userId: string, vaultId: string): boolean {
  return vaultRole(db, userId, vaultId) !== null;
}

export function personalVaultId(db: Db, userId: string): string {
  const row = db.select({ id: vaults.id }).from(vaults).where(eq(vaults.personalOfUserId, userId)).get();
  if (!row) throw new HttpError(404, 'vault_not_found');
  return row.id;
}

export type DefaultVault = { id: string; name: string; personal: boolean };

/**
 * A device's effective default vault (where it creates secrets without an explicit vault): its stored default_vault_id if the
 * owner can still access it, else the owner's personal vault. Null for devices without an owner (e.g. pending).
 */
export function deviceDefaultVault(db: Db, deviceId: string): DefaultVault | null {
  const dev = db.$client.prepare('SELECT user_id, default_vault_id FROM devices WHERE id = ?').get(deviceId) as
    | { user_id: string | null; default_vault_id: string | null }
    | undefined;
  if (!dev?.user_id) return null;
  const row = db.$client
    .prepare(
      `SELECT v.id, v.name, v.personal_of_user_id IS NOT NULL AS personal FROM vaults v
        WHERE (v.id = @explicit AND v.id IN (SELECT vault_id FROM vault_members WHERE user_id = @userId))
           OR v.personal_of_user_id = @userId
        ORDER BY v.id = @explicit DESC LIMIT 1`,
    )
    .get({ explicit: dev.default_vault_id, userId: dev.user_id }) as { id: string; name: string; personal: number } | undefined;
  return row ? { id: row.id, name: row.name, personal: row.personal === 1 } : null;
}

function toDto(db: Db, vault: typeof vaults.$inferSelect, role: VaultRole): VaultDto {
  const members = db
    .select({ userId: vaultMembers.userId, username: users.username, role: vaultMembers.role })
    .from(vaultMembers)
    .innerJoin(users, eq(users.id, vaultMembers.userId))
    .where(eq(vaultMembers.vaultId, vault.id))
    .orderBy(users.username)
    .all();
  return { id: vault.id, name: vault.name, personal: vault.personalOfUserId !== null, role, members, createdAt: vault.createdAt };
}

/** Vault the user is a member of, else 404 (no existence oracle). */
export function getVaultForUser(db: Db, userId: string, vaultId: string): VaultDto {
  const role = vaultRole(db, userId, vaultId);
  const vault = role && db.select().from(vaults).where(eq(vaults.id, vaultId)).get();
  if (!role || !vault) throw new HttpError(404, 'not_found');
  return toDto(db, vault, role);
}

export function listVaultsForUser(db: Db, userId: string): VaultDto[] {
  return db
    .select({ vault: vaults, role: vaultMembers.role })
    .from(vaults)
    .innerJoin(vaultMembers, and(eq(vaultMembers.vaultId, vaults.id), eq(vaultMembers.userId, userId)))
    .orderBy(vaults.createdAt, vaults.name)
    .all()
    .map((r) => toDto(db, r.vault, r.role));
}

export function createVault(ctx: ServiceCtx, userId: string, name: string): VaultDto {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) throw new ValidationError('invalid_name');
  const id = newId('vlt');
  ctx.db.$client.transaction(() => {
    ctx.db.insert(vaults).values({ id, name: trimmed, personalOfUserId: null, createdAt: ctx.clock.now() }).run();
    ctx.db.insert(vaultMembers).values({ vaultId: id, userId, role: 'owner' }).run();
  })();
  return getVaultForUser(ctx.db, userId, id);
}

/** Member check (404), personal check (400), owner check (403). */
function requireOwnerOfShared(db: Db, userId: string, vaultId: string): void {
  const vault = getVaultForUser(db, userId, vaultId);
  if (vault.personal) throw new HttpError(400, 'personal_vault');
  if (vault.role !== 'owner') throw new HttpError(403, 'not_owner');
}

export function addMember(
  ctx: ServiceCtx,
  actorUserId: string,
  vaultId: string,
  input: { username: string; role?: VaultRole },
  info: RequestInfo = {},
): VaultDto {
  const { db } = ctx;
  requireOwnerOfShared(db, actorUserId, vaultId);
  const target = db.select({ id: users.id }).from(users).where(eq(users.username, input.username.toLowerCase())).get();
  if (!target) throw new HttpError(404, 'user_not_found');
  if (canAccessVault(db, target.id, vaultId)) throw new HttpError(409, 'already_member');
  const role = input.role ?? 'member';
  db.$client.transaction(() => {
    db.insert(vaultMembers).values({ vaultId, userId: target.id, role }).run();
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: actorUserId, event: 'vault.member_added', vaultId, ip: info.ip, meta: { userId: target.id, role },
    });
  })();
  return getVaultForUser(db, actorUserId, vaultId);
}

/** Returns the vault as seen by the actor, or null if the actor removed themself. */
export function removeMember(ctx: ServiceCtx, actorUserId: string, vaultId: string, userId: string, info: RequestInfo = {}): VaultDto | null {
  const { db } = ctx;
  requireOwnerOfShared(db, actorUserId, vaultId);
  const role = vaultRole(db, userId, vaultId);
  if (!role) throw new HttpError(404, 'not_member');
  db.$client.transaction(() => {
    if (role === 'owner') {
      const owners = db
        .select({ userId: vaultMembers.userId })
        .from(vaultMembers)
        .where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.role, 'owner')))
        .all();
      if (owners.length <= 1) throw new HttpError(409, 'last_owner');
    }
    db.delete(vaultMembers).where(and(eq(vaultMembers.vaultId, vaultId), eq(vaultMembers.userId, userId))).run();
    ctx.hooks.onVaultMemberRemoved(ctx, vaultId, userId);
    appendAudit(db, ctx.clock, {
      actorType: 'user', actorId: actorUserId, event: 'vault.member_removed', vaultId, ip: info.ip, meta: { userId, role },
    });
  })();
  return canAccessVault(db, actorUserId, vaultId) ? getVaultForUser(db, actorUserId, vaultId) : null;
}
