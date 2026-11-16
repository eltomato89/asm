import { newId } from '@asm/shared';
import { appendAudit } from '../audit/audit.js';
import type { RequestInfo, ServiceCtx } from '../context.js';
import type { Db } from '../db/client.js';
import { HttpError } from '../errors.js';
import type { DeviceIdentity } from '../oauth/bearer.js';
import { openVersion } from '../secrets/service.js';
import { canAccessVault } from '../vaults/service.js';

export const GRANT_TTL_MS = 15 * 60_000;
export const GRANT_DEFAULT_USES = 1;

export type Grant = { id: string; requestId: string; userId: string; secretId: string; usesLeft: number; expiresAt: number; createdAt: number };

export type Delivery = 'cli' | 'plaintext';

export type RedeemedGrant = { secretId: string; envName: string | null; value: string; delivery: Delivery };

/** Issued on approval of a `read` request (both deliveries); 15 min, 1 use. Call inside the decision transaction. */
export function issueGrant(ctx: ServiceCtx, request: { id: string; userId: string; secretId: string }): Grant {
  const now = ctx.clock.now();
  const grant: Grant = {
    id: newId('grt'),
    requestId: request.id,
    userId: request.userId,
    secretId: request.secretId,
    usesLeft: GRANT_DEFAULT_USES,
    expiresAt: now + GRANT_TTL_MS,
    createdAt: now,
  };
  ctx.db.$client
    .prepare(
      `INSERT INTO grants (id, request_id, user_id, secret_id, uses_left, expires_at, created_at)
       VALUES (@id, @requestId, @userId, @secretId, @usesLeft, @expiresAt, @createdAt)`,
    )
    .run(grant);
  return grant;
}

/** Grant id of an approved read request, only for the device that made the request; else null. */
export function grantIdForRequest(db: Db, requestId: string, deviceId: string): string | null {
  const row = db.$client
    .prepare(
      `SELECT g.id FROM grants g JOIN access_requests r ON r.id = g.request_id
        WHERE g.request_id = ? AND r.device_id = ? ORDER BY g.created_at DESC LIMIT 1`,
    )
    .get(requestId, deviceId) as { id: string } | undefined;
  return row?.id ?? null;
}

type GrantRow = {
  id: string; request_id: string; user_id: string; secret_id: string; uses_left: number; expires_at: number;
  delivery: Delivery | null; request_device_id: string; project: string; reason: string;
  vault_id: string; archived_at: number | null; env_name: string | null; current_version: number;
};

const MAX_HOSTNAME = 255;

/**
 * Redeems one use of a grant for an authenticated device. Shared by MCP plaintext delivery and CLI redemption.
 * - unknown / expired / consumed → 410 grant_gone
 * - other user, wrong device kind (cli), not the requesting device (plaintext), inactive device, lost vault access → 403 forbidden
 * - archived secret → 409 secret_archived
 * Every outcome is audited (grant.redeemed | secret.plaintext_delivered | grant.redeem_denied).
 */
export function redeemGrant(
  ctx: ServiceCtx,
  input: { grantId: string; device: DeviceIdentity },
  info: RequestInfo & { hostname?: string } = {},
): RedeemedGrant {
  const { db } = ctx;
  const { grantId, device } = input;
  const hostname = typeof info.hostname === 'string' && info.hostname.length > 0 ? info.hostname.slice(0, MAX_HOSTNAME) : undefined;

  // Decide (and audit) inside one transaction; throw outside so the denial audit row is committed.
  const outcome = db.$client.transaction((): { ok: RedeemedGrant } | { error: HttpError } => {
    const now = ctx.clock.now();
    const g = db.$client
      .prepare(
        `SELECT g.id, g.request_id, g.user_id, g.secret_id, g.uses_left, g.expires_at,
                r.delivery, r.device_id AS request_device_id, r.project, r.reason,
                s.vault_id, s.archived_at, s.env_name, s.current_version
           FROM grants g
           JOIN access_requests r ON r.id = g.request_id
           JOIN secrets s ON s.id = g.secret_id
          WHERE g.id = ?`,
      )
      .get(grantId) as GrantRow | undefined;

    const deny = (status: number, code: string, cause: string) => {
      appendAudit(db, ctx.clock, {
        actorType: 'device', actorId: device.id, deviceId: device.id, event: 'grant.redeem_denied',
        secretId: g?.secret_id, vaultId: g?.vault_id, ip: info.ip,
        meta: { grantId, cause, ...(hostname ? { hostname } : {}) },
      });
      return { error: new HttpError(status, code) };
    };

    if (!g) return deny(410, 'grant_gone', 'not_found');
    if (g.user_id !== device.userId) return deny(403, 'forbidden', 'wrong_user');
    const active = db.$client.prepare("SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND status = 'approved'").get(device.id, device.userId);
    if (!active) return deny(403, 'forbidden', 'device_inactive');
    if (g.expires_at <= now) return deny(410, 'grant_gone', 'expired');
    if (g.uses_left <= 0) return deny(410, 'grant_gone', 'consumed');
    if (g.delivery === 'cli' && device.kind !== 'cli') return deny(403, 'forbidden', 'wrong_device_kind');
    if (g.delivery === 'plaintext' && device.id !== g.request_device_id) return deny(403, 'forbidden', 'wrong_device');
    if (g.delivery !== 'cli' && g.delivery !== 'plaintext') return deny(403, 'forbidden', 'no_delivery');
    if (g.archived_at !== null) return deny(409, 'secret_archived', 'archived');
    if (!canAccessVault(db, device.userId, g.vault_id)) return deny(403, 'forbidden', 'no_vault_access');

    const used = db.$client
      .prepare('UPDATE grants SET uses_left = uses_left - 1 WHERE id = ? AND uses_left > 0 AND expires_at > ?')
      .run(g.id, now);
    if (used.changes === 0) return deny(410, 'grant_gone', 'consumed');

    const { plaintext } = openVersion(ctx, g.secret_id, g.current_version);
    appendAudit(db, ctx.clock, {
      actorType: 'device', actorId: device.id, deviceId: device.id,
      event: g.delivery === 'plaintext' ? 'secret.plaintext_delivered' : 'grant.redeemed',
      secretId: g.secret_id, vaultId: g.vault_id, project: g.project, reason: g.reason, ip: info.ip,
      meta: { grantId: g.id, requestId: g.request_id, version: g.current_version, ...(hostname ? { hostname } : {}) },
    });
    return { ok: { secretId: g.secret_id, envName: g.env_name, value: plaintext, delivery: g.delivery } };
  })();

  if ('error' in outcome) throw outcome.error;
  return outcome.ok;
}
