import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { HttpError } from '../errors.js';
import type { DeviceIdentity } from '../oauth/bearer.js';
import { SESSION_COOKIE, findSession, type Session, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | undefined;
    session: Session | undefined;
    /** Set by bearerAuth (oauth/bearer.ts) for Bearer-authenticated devices. */
    device: DeviceIdentity | undefined;
  }
}

/** Login CSRF: browsers always send Origin on cross-site POSTs. */
export function checkLoginOrigin(req: FastifyRequest, publicOrigin: string): void {
  if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin) throw new HttpError(403, 'bad_origin');
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Installs cookie-session resolution (req.user / req.session) and the Origin check.
 * Requires @fastify/cookie to be registered first. Applies to every mutating request carrying the cookie (not path-based: req.url is undecoded). Requests without the session
 * cookie (e.g. Bearer devices) are exempt from the Origin check.
 */
export function installAuthContext(app: FastifyInstance, deps: { db: Db; clock: Clock; publicOrigin: string }): void {
  app.decorateRequest('user', undefined);
  app.decorateRequest('session', undefined);
  app.decorateRequest('device', undefined);
  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    if (MUTATING.has(req.method) && req.headers.origin !== deps.publicOrigin) {
      return reply.status(403).send({ error: 'bad_origin' });
    }
    const found = findSession(deps.db, deps.clock, token);
    if (found) {
      req.user = found.user;
      req.session = found.session;
    }
  });
}

export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw new HttpError(401, 'unauthenticated');
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(req, reply);
  if (!req.user!.isAdmin) throw new HttpError(403, 'forbidden');
}

export function requireRecentAuth(clock: Clock, maxAgeMs = 600_000) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(req, reply);
    if (clock.now() - req.session!.lastAuthAt > maxAgeMs) throw new HttpError(401, 'reauth_required');
  };
}
