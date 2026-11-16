import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { hashToken } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { devices, tokens } from '../db/schema.js';
import { protectedResourceMetadataUrl } from './metadata.js';
import { ACCESS_TOKEN_PREFIX } from './token.js';

/** Authenticated Bearer device (set on req.device by bearerAuth). */
export type DeviceIdentity = { id: string; userId: string; kind: 'mcp' | 'cli'; name: string };

const BEARER_RE = /^Bearer +([A-Za-z0-9._~+/=-]+) *$/i;

/**
 * preHandler factory: requires a valid, unexpired, unrevoked access token of an `approved` device.
 * On failure: 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1).
 */
export function bearerAuth(deps: { db: Db; clock: Clock; publicOrigin: string }) {
  const challenge = `Bearer resource_metadata="${protectedResourceMetadataUrl(deps.publicOrigin)}"`;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const m = BEARER_RE.exec(req.headers.authorization ?? '');
    if (!m) {
      await reply.status(401).header('www-authenticate', challenge).send({ error: 'unauthenticated' });
      return;
    }
    const token = m[1]!;
    const now = deps.clock.now();
    const row = token.startsWith(ACCESS_TOKEN_PREFIX)
      ? deps.db
          .select({ id: devices.id, userId: devices.userId, kind: devices.kind, name: devices.name })
          .from(tokens)
          .innerJoin(devices, eq(devices.id, tokens.deviceId))
          .where(
            and(
              eq(tokens.tokenHash, hashToken(token)),
              eq(tokens.kind, 'access'),
              isNull(tokens.revokedAt),
              gt(tokens.expiresAt, now),
              eq(devices.status, 'approved'),
            ),
          )
          .get()
      : undefined;
    if (!row || row.userId === null) {
      await reply.status(401).header('www-authenticate', `${challenge}, error="invalid_token"`).send({ error: 'invalid_token' });
      return;
    }
    deps.db.update(devices).set({ lastUsedAt: now }).where(eq(devices.id, row.id)).run();
    req.device = { id: row.id, userId: row.userId, kind: row.kind, name: row.name };
  };
}
