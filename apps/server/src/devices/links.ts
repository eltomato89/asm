import type { LinkCandidate as LinkCandidateDto } from '@asm/shared';
import type { Db } from '../db/client.js';

/**
 * Device links (leaf module: DB reads only, no service imports).
 *
 * An approved 'cli' device can be attached to an approved 'mcp' main device of the same user
 * (`devices.linked_to_device_id`, no chains). Main + attached CLIs form a group: settings (standing
 * approval, default vault) live on the main device, and grants of a group are only redeemable within it.
 */

export type AttachedCli = { id: string; name: string; hostname: string | null; lastUsedAt: number | null };
/** A link candidate without its standing approval summary (added by the activation route). */
export type LinkCandidate = Omit<LinkCandidateDto, 'standing'>;

/** The device whose settings (standing approval, default vault) apply: the main device for an attached CLI, else itself. */
export function settingsDeviceId(db: Db, deviceId: string): string {
  const row = db.$client.prepare('SELECT COALESCE(linked_to_device_id, id) AS sid FROM devices WHERE id = ?').get(deviceId) as
    | { sid: string }
    | undefined;
  return row?.sid ?? deviceId;
}

/** Approved CLIs attached to `mainId`, oldest first. */
export function attachedClis(db: Db, mainId: string): AttachedCli[] {
  const rows = db.$client
    .prepare(
      `SELECT id, name, hostname, last_used_at AS lastUsedAt FROM devices
        WHERE linked_to_device_id = ? AND kind = 'cli' AND status = 'approved'
        ORDER BY created_at, id`,
    )
    .all(mainId) as AttachedCli[];
  return rows;
}

/** True if the device is attached to a main device, or is a main device with at least one approved attached CLI. */
export function isGroupRestricted(db: Db, requestDeviceId: string): boolean {
  const row = db.$client
    .prepare(
      `SELECT d.linked_to_device_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM devices c WHERE c.linked_to_device_id = d.id AND c.kind = 'cli' AND c.status = 'approved') AS r
         FROM devices d WHERE d.id = ?`,
    )
    .get(requestDeviceId) as { r: number } | undefined;
  return row?.r === 1;
}

/** True if both devices exist and share the same settings device (same group, or the same device). */
export function sameGroup(db: Db, a: string, b: string): boolean {
  const rows = db.$client
    .prepare('SELECT id, COALESCE(linked_to_device_id, id) AS sid FROM devices WHERE id IN (?, ?)')
    .all(a, b) as { id: string; sid: string }[];
  const sa = rows.find((r) => r.id === a)?.sid;
  const sb = rows.find((r) => r.id === b)?.sid;
  return sa !== undefined && sb !== undefined && sa === sb;
}

/** Approved 'mcp' devices of the user a CLI can be attached to, most recently used first. */
export function linkCandidates(db: Db, userId: string): LinkCandidate[] {
  return db.$client
    .prepare(
      `SELECT d.id, d.name, d.last_used_at AS lastUsedAt, d.created_at AS createdAt,
              (SELECT COUNT(*) FROM devices c WHERE c.linked_to_device_id = d.id AND c.kind = 'cli' AND c.status = 'approved') AS attachedCount
         FROM devices d
        WHERE d.user_id = ? AND d.kind = 'mcp' AND d.status = 'approved'
        ORDER BY d.last_used_at IS NULL, d.last_used_at DESC, d.created_at DESC, d.id`,
    )
    .all(userId) as LinkCandidate[];
}
