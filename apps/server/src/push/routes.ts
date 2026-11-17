import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  ApproveDecisionInputSchema,
  PushSubscribeInputSchema,
  StandingApproveDecisionInputSchema,
  type AccessRequestDto,
  type ApproveSummaryDto,
  type StandingApproveSummaryDto,
  type StandingRequestDto,
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
import { decideStandingRequest, getStandingRequestDto } from '../standing/requests.js';
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

function toStandingSummary(dto: StandingRequestDto): StandingApproveSummaryDto {
  return {
    device: { name: dto.device.name },
    attachedCli: dto.attachedCli,
    project: dto.project,
    reason: dto.reason,
    proposal: dto.proposal,
    items: dto.items,
    limits: dto.limits,
    status: dto.status,
    expiresAt: dto.expiresAt,
    final: dto.final,
    adjusted: dto.adjusted,
    replaces: dto.replaces,
  };
}

/** Token tables behind push approval links: access requests and standing approval proposals. */
const LINK_KINDS = {
  access: { tokens: 'approve_tokens', fk: 'request_id', requests: 'access_requests', challengePrefix: 'approve' },
  standing: { tokens: 'standing_approve_tokens', fk: 'standing_request_id', requests: 'standing_requests', challengePrefix: 'approve-standing' },
} as const;
type LinkKind = keyof typeof LINK_KINDS;
type ResolvedToken = { kind: LinkKind; tokenHash: string; requestId: string; userId: string };

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

  const markRequestTokensUsed = (kind: LinkKind, requestId: string) => {
    const k = LINK_KINDS[kind];
    db.$client.prepare(`UPDATE ${k.tokens} SET used_at = ? WHERE ${k.fk} = ? AND used_at IS NULL`).run(clock.now(), requestId);
  };

  /** Valid = unused, unexpired token of an active owner whose request is still open; anything else is the same 404. */
  function resolveToken(kind: LinkKind, token: string): ResolvedToken {
    if (!TOKEN_RE.test(token)) throw new HttpError(404, 'not_found');
    const k = LINK_KINDS[kind];
    const tokenHash = hashApproveToken(token);
    const row = db.$client
      .prepare(
        `SELECT t.${k.fk} AS request_id, t.user_id, t.used_at, t.expires_at, r.status AS req_status, r.expires_at AS req_expires,
                r.user_id AS req_user, u.disabled_at
           FROM ${k.tokens} t
           JOIN ${k.requests} r ON r.id = t.${k.fk}
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
      markRequestTokensUsed(kind, row.request_id);
      throw new HttpError(404, 'not_found');
    }
    if (row.used_at !== null || row.expires_at <= now || row.req_user !== row.user_id || row.disabled_at !== null) {
      throw new HttpError(404, 'not_found');
    }
    return { kind, tokenHash, requestId: row.request_id, userId: row.user_id };
  }

  const challengeKey = (t: ResolvedToken) => `${LINK_KINDS[t.kind].challengePrefix}:${t.tokenHash}`;
  const ownerPasskeys = (userId: string) => db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();

  /** WebAuthn options (UV required) for the link owner's passkeys; the challenge is bound to this link. */
  async function passkeyOptions(t: ResolvedToken) {
    const mine = ownerPasskeys(t.userId);
    if (mine.length === 0) throw new HttpError(409, 'no_passkey');
    const options = await adapter.generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: mine.map((p) => ({ id: p.credentialId, ...(p.transports ? { transports: p.transports } : {}) })) as never,
    });
    challenges.put(options.challenge, 'approve', t.userId, challengeKey(t));
    return options;
  }

  /** Face ID / device PIN required: the assertion must be for this link's challenge, by the owner's passkey, with the UV flag. */
  async function requireUserVerification(t: ResolvedToken, rawResponse: unknown): Promise<void> {
    const expected = challenges.take(challengeKey(t), 'approve', t.userId);
    const response = rawResponse as AuthenticationResponseJSON | undefined;
    const row = response
      ? db.select().from(passkeys).where(and(eq(passkeys.credentialId, response.id), eq(passkeys.userId, t.userId))).get()
      : undefined;
    if (!expected || !response || !row || !(await verifyAssertion({ db, adapter, origin, rpID }, response, expected, row, true))) {
      throw new HttpError(401, 'verification_failed');
    }
  }

  /** Atomic single use (also guards approve/deny racing on the same link). */
  function consumeToken(t: ResolvedToken): void {
    const k = LINK_KINDS[t.kind];
    const consumed = db.$client.prepare(`UPDATE ${k.tokens} SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`).run(clock.now(), t.tokenHash);
    if (consumed.changes === 0) throw new HttpError(404, 'not_found');
  }

  /** Once the request is no longer pending, all its links are dead. */
  function retireIfDecided(t: ResolvedToken): void {
    const cur = db.$client.prepare(`SELECT status FROM ${LINK_KINDS[t.kind].requests} WHERE id = ?`).get(t.requestId) as { status: string } | undefined;
    if (cur && cur.status !== 'pending') markRequestTokensUsed(t.kind, t.requestId);
  }

  // ---------- access requests ----------

  app.get('/api/approve/:token', async (req) => {
    const t = resolveToken('access', tokenParams.parse(req.params).token);
    return toSummary(getRequestDto(ctx, t.requestId));
  });

  app.post('/api/approve/:token/options', async (req) => {
    checkLoginOrigin(req, origin);
    return passkeyOptions(resolveToken('access', tokenParams.parse(req.params).token));
  });

  app.post('/api/approve/:token/decision', async (req) => {
    checkLoginOrigin(req, origin);
    const t = resolveToken('access', tokenParams.parse(req.params).token);
    const body = ApproveDecisionInputSchema.parse(req.body);
    if (body.decision === 'approve') await requireUserVerification(t, body.response);
    consumeToken(t);
    try {
      const dto = decideRequest(ctx, { requestId: t.requestId, userId: t.userId, decision: body.decision }, { ip: req.ip }, { via: 'push' });
      return toSummary(dto);
    } finally {
      retireIfDecided(t);
    }
  });

  // ---------- standing approval proposals ----------

  app.get('/api/approve/standing/:token', async (req) => {
    const t = resolveToken('standing', tokenParams.parse(req.params).token);
    return toStandingSummary(getStandingRequestDto(ctx, t.requestId));
  });

  app.post('/api/approve/standing/:token/options', async (req) => {
    checkLoginOrigin(req, origin);
    return passkeyOptions(resolveToken('standing', tokenParams.parse(req.params).token));
  });

  app.post('/api/approve/standing/:token/decision', async (req) => {
    checkLoginOrigin(req, origin);
    const t = resolveToken('standing', tokenParams.parse(req.params).token);
    const body = StandingApproveDecisionInputSchema.parse(req.body);
    if (body.decision === 'approve') await requireUserVerification(t, body.response);
    try {
      // Token consumption runs inside the decision's own transaction: a rejected decision (e.g. not_narrower) leaves the link
      // usable, a system cancellation (e.g. standing_active) commits together with it. Events go out after that commit.
      const dto = decideStandingRequest(
        ctx,
        {
          id: t.requestId, userId: t.userId, decision: body.decision,
          ...(body.decision === 'approve' && body.settings ? { settings: body.settings } : {}),
        },
        { ip: req.ip },
        { via: 'push' },
        () => consumeToken(t),
      );
      return toStandingSummary(dto);
    } finally {
      retireIfDecided(t);
    }
  });
}

export async function registerPushRoutes(app: FastifyInstance, deps: PushDeps): Promise<void> {
  await app.register(registerPushApi, deps);
  await app.register(registerApproveApi, deps);
}
