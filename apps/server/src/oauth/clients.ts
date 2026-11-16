import { newId } from '@asm/shared';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { oauthClients } from '../db/schema.js';
import { OAuthError } from '../errors.js';

export type OAuthClient = { id: string; name: string; redirectUris: string[] };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function parseUrl(s: string): URL | undefined {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

/** Allowed redirect URIs: https, or http on localhost/127.0.0.1 (any port/path); no fragment, no userinfo. */
export function isAllowedRedirectUri(s: string): boolean {
  const u = parseUrl(s);
  if (!u || s.includes('#') || u.username || u.password || !u.hostname) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/** Exact match against a registered URI; for loopback http redirects the port may differ (RFC 8252 §7.3). */
export function matchesRedirectUri(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const r = parseUrl(requested);
  if (!r || r.protocol !== 'http:' || !LOOPBACK_HOSTS.has(r.hostname) || requested.includes('#') || r.username || r.password) return false;
  return registered.some((s) => {
    const u = parseUrl(s);
    return !!u && u.protocol === 'http:' && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
  });
}

export function getClient(db: Db, clientId: string): OAuthClient | undefined {
  return db
    .select({ id: oauthClients.id, name: oauthClients.name, redirectUris: oauthClients.redirectUris })
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .get();
}

// RFC 7591: unknown metadata is ignored; known fields are validated.
const registerBody = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
});

export function registerClientRoutes(app: FastifyInstance, deps: ModuleDeps): void {
  const { ctx } = deps;
  app.post('/oauth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) {
      const badUris = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
      throw new OAuthError(badUris ? 'invalid_redirect_uri' : 'invalid_client_metadata');
    }
    const body = parsed.data;
    if (!body.redirect_uris.every(isAllowedRedirectUri)) throw new OAuthError('invalid_redirect_uri');
    const client = { id: newId('cli'), name: body.client_name ?? 'MCP Client', redirectUris: body.redirect_uris };
    const now = ctx.clock.now();
    ctx.db.insert(oauthClients).values({ ...client, createdAt: now }).run();
    return reply.status(201).header('cache-control', 'no-store').send({
      client_id: client.id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });
}
