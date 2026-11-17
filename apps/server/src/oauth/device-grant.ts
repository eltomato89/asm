import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { OAuthDeps } from '../app.js';
import { appendAudit } from '../audit/audit.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { hashToken } from '../auth/sessions.js';
import type { ServiceCtx } from '../context.js';
import type { ActivationInfo } from '@asm/shared';
import { deviceCodes, devices } from '../db/schema.js';
import { linkCandidates } from '../devices/links.js';
import { createDevice, linkInTxn } from '../devices/service.js';
import { emitDeviceChanged, standingSummaryForDevice } from '../standing/service.js';
import { HttpError, OAuthError } from '../errors.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_CODE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
/** Expired device codes are kept this long (so polls get `expired_token`) before cleanup. */
const EXPIRED_RETENTION_MS = 3600_000;

/** Per-device_code polling state for `slow_down` (RFC 8628 §3.5); in memory. */
export class PollTracker {
  private readonly state = new Map<string, { lastPollAt: number; intervalS: number; expiresAt: number }>();

  /** Records a poll; returns false if it came faster than the current interval (which then grows by 5 s). */
  check(codeHash: string, now: number, expiresAt: number): boolean {
    for (const [k, v] of this.state) if (v.expiresAt <= now) this.state.delete(k);
    const s = this.state.get(codeHash);
    if (!s) {
      this.state.set(codeHash, { lastPollAt: now, intervalS: POLL_INTERVAL_S, expiresAt });
      return true;
    }
    const tooFast = now - s.lastPollAt < s.intervalS * 1000;
    if (tooFast) s.intervalS += 5;
    s.lastPollAt = now;
    return !tooFast;
  }

  forget(codeHash: string): void {
    this.state.delete(codeHash);
  }
}

function generateUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Case-insensitive, hyphen optional; returns the canonical XXXX-XXXX form or undefined. */
export function normalizeUserCode(input: string): string | undefined {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return USER_CODE_RE.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : undefined;
}

/**
 * Handles one device_code poll at the token endpoint. Returns the issued tokens once after approval;
 * otherwise throws the RFC 8628 error.
 */
export function pollDeviceCode<T>(ctx: ServiceCtx, polls: PollTracker, deviceCode: string, issue: (deviceId: string) => T): T {
  const { db, clock } = ctx;
  const codeHash = hashToken(deviceCode);
  const now = clock.now();
  const row = db.select().from(deviceCodes).where(eq(deviceCodes.deviceCodeHash, codeHash)).get();
  if (!row) throw new OAuthError('invalid_grant');
  if (row.expiresAt <= now) throw new OAuthError('expired_token');
  if (!polls.check(codeHash, now, row.expiresAt)) throw new OAuthError('slow_down');
  if (row.status === 'pending') throw new OAuthError('authorization_pending');
  if (row.status === 'denied') throw new OAuthError('access_denied');
  polls.forget(codeHash);
  const issued = db.$client.transaction((): { tokens: T } | undefined => {
    // Consume: tokens are issued exactly once per device_code (also when the device was revoked meanwhile).
    db.delete(deviceCodes).where(eq(deviceCodes.deviceCodeHash, codeHash)).run();
    const dev = db.select({ status: devices.status, userId: devices.userId }).from(devices).where(eq(devices.id, row.deviceId)).get();
    return dev?.status === 'approved' && dev.userId ? { tokens: issue(row.deviceId) } : undefined;
  })();
  if (!issued) throw new OAuthError('invalid_grant');
  return issued.tokens;
}

const startBody = z.object({
  client_name: z.string().trim().min(1).max(100),
  hostname: z.string().trim().min(1).max(255).optional(),
});
const activateBody = z.strictObject({
  user_code: z.string().min(1).max(32),
  decision: z.enum(['approve', 'deny']),
  /** Approve only: attach the new CLI to this own approved 'mcp' main device. */
  link_to_device_id: z.string().min(1).max(100).nullable().optional(),
});
const userCodeQuery = z.object({ user_code: z.string().min(1).max(32) });

/** POST /oauth/device_authorization (unauthenticated, no client registration needed). */
export function registerDeviceAuthorizationRoute(app: FastifyInstance, deps: OAuthDeps): void {
  const { ctx, config } = deps;
  const { db, clock } = ctx;
  app.post('/oauth/device_authorization', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) throw new OAuthError('invalid_request');
    const { client_name: name, hostname } = parsed.data;
    const deviceCode = randomBytes(32).toString('base64url');
    const now = clock.now();
    let userCode = '';
    db.$client.transaction(() => {
      db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, now - EXPIRED_RETENTION_MS)).run();
      const deviceId = createDevice(ctx, { userId: null, name, kind: 'cli', status: 'pending', hostname: hostname ?? null });
      for (let attempt = 0; ; attempt++) {
        userCode = generateUserCode();
        if (!db.select({ u: deviceCodes.userCode }).from(deviceCodes).where(eq(deviceCodes.userCode, userCode)).get()) break;
        if (attempt >= 10) throw new Error('could not allocate user code');
      }
      db.insert(deviceCodes)
        .values({ deviceCodeHash: hashToken(deviceCode), userCode, deviceId, status: 'pending', expiresAt: now + DEVICE_CODE_TTL_MS })
        .run();
      appendAudit(db, clock, { actorType: 'system', actorId: null, event: 'device.pair_requested', deviceId, ip: req.ip });
    })();
    return reply.header('cache-control', 'no-store').send({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${config.publicUrl.origin}/activate`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
    });
  });
}

function findPendingCode(ctx: ServiceCtx, rawUserCode: string) {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) throw new HttpError(404, 'invalid_code');
  const row = ctx.db
    .select({ deviceCodeHash: deviceCodes.deviceCodeHash, deviceId: deviceCodes.deviceId, name: devices.name, hostname: devices.hostname, createdAt: devices.createdAt })
    .from(deviceCodes)
    .innerJoin(devices, eq(devices.id, deviceCodes.deviceId))
    .where(and(eq(deviceCodes.userCode, userCode), eq(deviceCodes.status, 'pending'), gt(deviceCodes.expiresAt, ctx.clock.now()), eq(devices.status, 'pending')))
    .get();
  if (!row) throw new HttpError(404, 'invalid_code');
  return row;
}

/** Session-authenticated activation API used by the SPA page `/activate`. */
export function registerActivateRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const { ctx, clock } = deps;
  const { db } = ctx;
  const perUser = { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req: { user?: { id: string }; ip: string }) => req.user?.id ?? req.ip } };

  // Lets the UI show what is being paired (client name, hostname) and the main devices it could be attached to.
  app.get('/api/devices/activate', { preHandler: requireUser, config: perUser }, async (req): Promise<ActivationInfo> => {
    const row = findPendingCode(ctx, userCodeQuery.parse(req.query).user_code);
    // No preselection (linking is opt-in); each candidate carries its standing approval so the page can warn before linking.
    const candidates = linkCandidates(db, req.user!.id).map((c) => ({ ...c, standing: standingSummaryForDevice(ctx, c.id) }));
    return { name: row.name, hostname: row.hostname, requestedAt: row.createdAt, linkCandidates: candidates };
  });

  app.post('/api/devices/activate', { preHandler: [requireUser, requireRecentAuth(clock)], config: perUser }, async (req) => {
    const body = activateBody.parse(req.body);
    const row = findPendingCode(ctx, body.user_code);
    const userId = req.user!.id;
    const approve = body.decision === 'approve';
    const linkTo = approve ? (body.link_to_device_id ?? null) : null;
    // A link target that is not an own approved 'mcp' device throws inside the transaction: nothing is approved.
    const changed = db.$client.transaction((): string[] => {
      db.update(deviceCodes).set({ status: approve ? 'approved' : 'denied' }).where(eq(deviceCodes.deviceCodeHash, row.deviceCodeHash)).run();
      db.update(devices)
        .set(approve ? { status: 'approved', userId } : { status: 'denied' })
        .where(eq(devices.id, row.deviceId))
        .run();
      appendAudit(db, clock, {
        actorType: 'user', actorId: userId, event: approve ? 'device.approved' : 'device.denied', deviceId: row.deviceId, ip: req.ip,
        ...(linkTo ? { meta: { linkedTo: linkTo } } : {}),
      });
      return linkTo ? linkInTxn(ctx, userId, row.deviceId, linkTo, { ip: req.ip }, 'activation') : [];
    })();
    for (const id of changed) emitDeviceChanged(ctx, userId, id);
    return { deviceId: row.deviceId, status: approve ? 'approved' : 'denied' };
  });
}
