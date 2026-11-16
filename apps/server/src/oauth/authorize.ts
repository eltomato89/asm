import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { OAuthDeps } from '../app.js';
import { appendAudit } from '../audit/audit.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { hashToken } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import { oauthCodes } from '../db/schema.js';
import { createDevice } from '../devices/service.js';
import { HttpError } from '../errors.js';
import { getClient, matchesRedirectUri } from './clients.js';
import { mcpResource } from './metadata.js';
import { randomToken } from './token.js';

export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
const MAX_PENDING = 1000;
const MAX_STATE_LENGTH = 1024;

export type PendingAuthorization = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  createdAt: number;
};

/** In-memory store of validated authorization requests awaiting user consent. */
export class PendingAuthorizations {
  private readonly items = new Map<string, PendingAuthorization>();

  constructor(private readonly clock: Clock) {}

  add(p: Omit<PendingAuthorization, 'createdAt'>): string {
    this.purge();
    // Bound memory: the endpoint is unauthenticated. Map iteration order = insertion order.
    while (this.items.size >= MAX_PENDING) this.items.delete(this.items.keys().next().value!);
    const id = randomBytes(32).toString('base64url');
    this.items.set(id, { ...p, createdAt: this.clock.now() });
    return id;
  }

  get(id: string): PendingAuthorization | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    if (this.clock.now() - p.createdAt >= PENDING_AUTHORIZATION_TTL_MS) {
      this.items.delete(id);
      return undefined;
    }
    return p;
  }

  /** Returns and removes the request (consumed by any decision). */
  take(id: string): PendingAuthorization | undefined {
    const p = this.get(id);
    this.items.delete(id);
    return p;
  }

  private purge(): void {
    const now = this.clock.now();
    for (const [id, p] of this.items) if (now - p.createdAt >= PENDING_AUTHORIZATION_TTL_MS) this.items.delete(id);
  }
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function registerAuthorizeRoute(app: FastifyInstance, deps: OAuthDeps): void {
  const { ctx, config, pending } = deps;
  const resource = mcpResource(config.publicUrl.origin);

  app.get('/oauth/authorize', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    // Repeated parameters arrive as arrays and are treated as invalid (RFC 6749 §3.1).
    const param = (name: string): string | undefined | null => {
      const v = q[name];
      if (v === undefined || v === '') return undefined;
      return typeof v === 'string' && v.length <= 4096 ? v : null;
    };
    const fail = (error: string) => reply.status(400).header('cache-control', 'no-store').send({ error });

    // 1. Client and redirect URI first: on failure never redirect.
    const clientId = param('client_id');
    const client = typeof clientId === 'string' ? getClient(ctx.db, clientId) : undefined;
    if (!client) return fail('invalid_client');
    let redirectUri = param('redirect_uri');
    if (redirectUri === undefined && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (typeof redirectUri !== 'string' || !matchesRedirectUri(client.redirectUris, redirectUri)) return fail('invalid_redirect_uri');

    // 2. Everything else is reported to the client via redirect.
    const rawState = param('state');
    const state = typeof rawState === 'string' && rawState.length <= MAX_STATE_LENGTH ? rawState : undefined;
    const redirectError = (error: string): FastifyReply => reply.redirect(withParams(redirectUri, { error, state }), 302);
    if (rawState === null || (rawState !== undefined && state === undefined)) return redirectError('invalid_request');
    const responseType = param('response_type');
    if (responseType === undefined || responseType === null) return redirectError('invalid_request');
    if (responseType !== 'code') return redirectError('unsupported_response_type');
    const challenge = param('code_challenge');
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge) || param('code_challenge_method') !== 'S256') {
      return redirectError('invalid_request');
    }
    const res = param('resource');
    if (res === null || (res !== undefined && res !== resource)) return redirectError('invalid_target');

    const id = pending.add({ clientId: client.id, clientName: client.name, redirectUri, codeChallenge: challenge, state });
    return reply.redirect(`/connect?req=${id}`, 302);
  });
}

const reqParams = z.object({ req: z.string().min(1).max(100) });
const consentBody = z.strictObject({
  req: z.string().min(1).max(100),
  decision: z.enum(['approve', 'deny']),
  deviceName: z.string().trim().min(1).max(100).optional(),
});

/** Session-authenticated consent API used by the SPA page `/connect`. */
export function registerConsentRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const { ctx, clock, pending } = deps;

  app.get('/api/oauth/consent/:req', { preHandler: requireUser }, async (req) => {
    const p = pending.get(reqParams.parse(req.params).req);
    if (!p) throw new HttpError(404, 'unknown_request');
    return { clientName: p.clientName, redirectHost: new URL(p.redirectUri).host, requestedAt: p.createdAt };
  });

  app.post('/api/oauth/consent', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const body = consentBody.parse(req.body);
    const p = pending.take(body.req);
    if (!p) throw new HttpError(404, 'unknown_request');
    const userId = req.user!.id;

    if (body.decision === 'deny') {
      appendAudit(ctx.db, clock, { actorType: 'user', actorId: userId, event: 'device.denied', ip: req.ip, meta: { clientName: p.clientName } });
      return { redirectTo: withParams(p.redirectUri, { error: 'access_denied', state: p.state }) };
    }

    const code = randomToken();
    ctx.db.$client.transaction(() => {
      const deviceId = createDevice(ctx, { userId, name: body.deviceName ?? p.clientName, kind: 'mcp', status: 'approved' });
      ctx.db
        .insert(oauthCodes)
        .values({
          codeHash: hashToken(code),
          clientId: p.clientId,
          deviceId,
          userId,
          codeChallenge: p.codeChallenge,
          redirectUri: p.redirectUri,
          expiresAt: clock.now() + AUTHORIZATION_CODE_TTL_MS,
        })
        .run();
      appendAudit(ctx.db, clock, { actorType: 'user', actorId: userId, event: 'device.approved', deviceId, ip: req.ip });
    })();
    return { redirectTo: withParams(p.redirectUri, { code, state: p.state }) };
  });
}
