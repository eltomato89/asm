import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  ApproveDecisionInputSchema,
  PushSubscribeInputSchema,
  type AccessRequestDto,
  type ApproveSummaryDto,
} from '@asm/shared';
import rateLimit from '@fastify/rate-limit';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { checkLoginOrigin, requireUser } from '../auth/guards.js';
import { ChallengeStore, realWebAuthn, verifyAssertion } from '../auth/webauthn.js';
import { passkeys } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { decideRequest, getRequestDto } from '../requests/service.js';
import { deleteSubscription, hashApproveToken, listSubscriptions, TEST_PAYLOAD, upsertSubscription, type PushService } from './service.js';

export type PushDeps = ModuleDeps & { push: PushService };

const rateLimited = () => new HttpError(429, 'rate_limited');
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const idParams = z.object({ id: z.string().min(1).max(100) });
const tokenParams = z.object({ token: z.string() });
export const APPROVE_RATE_LIMIT = 30;

/** Session-authenticated subscription management (/api/push/*). */
async function registerPushApi(app: FastifyInstance, deps: PushDeps): Promise<void> {
  const { ctx, push } = deps;
  await app.register(rateLimit, { global: false, errorResponseBuilder: rateLimited });

  app.get('/api/push/vapid-key', { preHandler: requireUser }, async () => ({ publicKey: push.publicKey }));

  app.get('/api/push/subscriptions', { preHandler: requireUser }, async (req) => ({ items: listSubscriptions(ctx.db, req.user!.id) }));

  app.post('/api/push/subscriptions', { preHandler: requireUser }, async (req, reply) => {
    const body = PushSubscribeInputSchema.parse(req.body);
    return reply.status(201).send(upsertSubscription(ctx.db, ctx.clock, req.user!.id, body));
  });

  app.delete('/api/push/subscriptions/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    deleteSubscription(ctx.db, req.user!.id, id);
    return reply.status(204).send();
  });

  app.post(
    '/api/push/test',
    { preHandler: requireUser, config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip } } },
    async (req) => ({ sent: await push.sendToUser(ctx, req.user!.id, TEST_PAYLOAD) }),
  );
}

/** Public page shows which fields change; values only for title and env name (description/tags are redacted). */
const PUBLIC_DIFF_FIELDS = new Set(['title', 'envName']);
function publicMetaDiff(diff: NonNullable<AccessRequestDto['metaDiff']>): NonNullable<ApproveSummaryDto['metaDiff']> {
  return Object.fromEntries(
    Object.entries(diff).map(([k, d]) => [k, PUBLIC_DIFF_FIELDS.has(k) ? { from: d!.from, to: d!.to } : { from: null, to: null, redacted: true as const }]),
  );
}

function toSummary(dto: AccessRequestDto): ApproveSummaryDto {
  return {
    kind: dto.kind,
    device: { name: dto.device.name },
    secret: { title: dto.secret.title, envName: dto.secret.envName },
    project: dto.project,
    reason: dto.reason,
    delivery: dto.delivery,
    ...(dto.metaDiff !== undefined ? { metaDiff: publicMetaDiff(dto.metaDiff) } : {}),
    ...(dto.valueChanged !== undefined ? { valueChanged: dto.valueChanged } : {}),
    expiresAt: dto.expiresAt,
    status: dto.status,
    ...(dto.renewal ? { renewal: dto.renewal } : {}),
  };
}

/** Public, session-less approval API for push links (/api/approve/*); rate limited per IP, never cached. */
async function registerApproveApi(app: FastifyInstance, deps: PushDeps): Promise<void> {
  const { ctx, config } = deps;
  const { db, clock } = ctx;
  const adapter = deps.webauthn ?? realWebAuthn;
  const rpID = config.publicUrl.hostname;
  const origin = config.publicUrl.origin;
  const challenges = new ChallengeStore(clock);

  // Encapsulated: one shared per-IP budget across these routes only.
  await app.register(rateLimit, { global: true, max: APPROVE_RATE_LIMIT, timeWindow: '1 minute', errorResponseBuilder: rateLimited });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const markRequestTokensUsed = (requestId: string) =>
    db.$client.prepare('UPDATE approve_tokens SET used_at = ? WHERE request_id = ? AND used_at IS NULL').run(clock.now(), requestId);

  /** Valid = unused, unexpired token of an active owner whose request is still open; anything else is the same 404. */
  function resolveToken(token: string): { tokenHash: string; requestId: string; userId: string } {
    if (!TOKEN_RE.test(token)) throw new HttpError(404, 'not_found');
    const tokenHash = hashApproveToken(token);
    const row = db.$client
      .prepare(
        `SELECT t.request_id, t.user_id, t.used_at, t.expires_at, r.status AS req_status, r.expires_at AS req_expires,
                r.user_id AS req_user, u.disabled_at
           FROM approve_tokens t
           JOIN access_requests r ON r.id = t.request_id
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?`,
      )
      .get(tokenHash) as
      | { request_id: string; user_id: string; used_at: number | null; expires_at: number; req_status: string; req_expires: number;
          req_user: string | null; disabled_at: number | null }
      | undefined;
    if (!row) throw new HttpError(404, 'not_found');
    const now = clock.now();
    if (row.req_status !== 'pending' || row.req_expires <= now) {
      // Decided elsewhere (dashboard, system) or overdue: every link for it is dead.
      markRequestTokensUsed(row.request_id);
      throw new HttpError(404, 'not_found');
    }
    if (row.used_at !== null || row.expires_at <= now || row.req_user !== row.user_id || row.disabled_at !== null) {
      throw new HttpError(404, 'not_found');
    }
    return { tokenHash, requestId: row.request_id, userId: row.user_id };
  }

  const challengeKey = (tokenHash: string) => `approve:${tokenHash}`;
  const ownerPasskeys = (userId: string) => db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();

  app.get('/api/approve/:token', async (req) => {
    const t = resolveToken(tokenParams.parse(req.params).token);
    return toSummary(getRequestDto(ctx, t.requestId));
  });

  app.post('/api/approve/:token/options', async (req) => {
    checkLoginOrigin(req, origin);
    const t = resolveToken(tokenParams.parse(req.params).token);
    const mine = ownerPasskeys(t.userId);
    if (mine.length === 0) throw new HttpError(409, 'no_passkey');
    const options = await adapter.generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: mine.map((p) => ({ id: p.credentialId, ...(p.transports ? { transports: p.transports } : {}) })) as never,
    });
    challenges.put(options.challenge, 'approve', t.userId, challengeKey(t.tokenHash));
    return options;
  });

  app.post('/api/approve/:token/decision', async (req) => {
    checkLoginOrigin(req, origin);
    const t = resolveToken(tokenParams.parse(req.params).token);
    const body = ApproveDecisionInputSchema.parse(req.body);
    if (body.decision === 'approve') {
      const expected = challenges.take(challengeKey(t.tokenHash), 'approve', t.userId);
      const response = body.response as unknown as AuthenticationResponseJSON | undefined;
      const row = response
        ? db.select().from(passkeys).where(and(eq(passkeys.credentialId, response.id), eq(passkeys.userId, t.userId))).get()
        : undefined;
      // Face ID / device PIN required: the assertion must carry the UV flag.
      if (!expected || !response || !row || !(await verifyAssertion({ db, adapter, origin, rpID }, response, expected, row, true))) {
        throw new HttpError(401, 'verification_failed');
      }
    }
    // Atomic single use (also guards approve/deny racing on the same link).
    const consumed = db.$client.prepare('UPDATE approve_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(clock.now(), t.tokenHash);
    if (consumed.changes === 0) throw new HttpError(404, 'not_found');
    try {
      const dto = decideRequest(ctx, { requestId: t.requestId, userId: t.userId, decision: body.decision }, { ip: req.ip }, { via: 'push' });
      return toSummary(dto);
    } finally {
      const cur = db.$client.prepare('SELECT status FROM access_requests WHERE id = ?').get(t.requestId) as { status: string } | undefined;
      if (cur && cur.status !== 'pending') markRequestTokensUsed(t.requestId);
    }
  });
}

export async function registerPushRoutes(app: FastifyInstance, deps: PushDeps): Promise<void> {
  await app.register(registerPushApi, deps);
  await app.register(registerApproveApi, deps);
}
