import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from '@asm/shared';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { OAuthDeps } from '../app.js';
import { hashToken } from '../auth/sessions.js';
import type { ServiceCtx } from '../context.js';
import { devices, oauthCodes, tokens } from '../db/schema.js';
import { revokeDevice } from '../devices/service.js';
import { OAuthError } from '../errors.js';
import { getClient } from './clients.js';
import { DEVICE_CODE_GRANT, pollDeviceCode } from './device-grant.js';
import { mcpResource } from './metadata.js';

export const ACCESS_TOKEN_PREFIX = 'asm_at_';
export const REFRESH_TOKEN_PREFIX = 'asm_rt_';
export const ACCESS_TOKEN_TTL_MS = 3600_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;

/** 32 random bytes, base64url. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

export type IssuedTokens = { accessToken: string; refreshToken: string; expiresIn: number };

/** Issues a fresh access/refresh token pair for a device; only sha256 hashes are stored. */
export function issueTokens(ctx: ServiceCtx, deviceId: string): IssuedTokens {
  const now = ctx.clock.now();
  const accessToken = ACCESS_TOKEN_PREFIX + randomToken();
  const refreshToken = REFRESH_TOKEN_PREFIX + randomToken();
  ctx.db
    .insert(tokens)
    .values([
      { id: newId('tok'), deviceId, kind: 'access', tokenHash: hashToken(accessToken), expiresAt: now + ACCESS_TOKEN_TTL_MS },
      { id: newId('tok'), deviceId, kind: 'refresh', tokenHash: hashToken(refreshToken), expiresAt: now + REFRESH_TOKEN_TTL_MS },
    ])
    .run();
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
}

const tokenResponse = (t: IssuedTokens) => ({
  access_token: t.accessToken,
  token_type: 'Bearer',
  expires_in: t.expiresIn,
  refresh_token: t.refreshToken,
});

/** Reads a single string parameter from a form/JSON body; repeated or non-string values are invalid. */
export function bodyParam(body: unknown, name: string, required: true): string;
export function bodyParam(body: unknown, name: string, required?: false): string | undefined;
export function bodyParam(body: unknown, name: string, required = false): string | undefined {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  if (v === undefined || v === '') {
    if (required) throw new OAuthError('invalid_request', `missing ${name}`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > 4096) throw new OAuthError('invalid_request', `invalid ${name}`);
  return v;
}

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function checkResource(body: unknown, origin: string): void {
  const resource = bodyParam(body, 'resource');
  if (resource !== undefined && resource !== mcpResource(origin)) throw new OAuthError('invalid_target');
}

function isActiveDevice(ctx: ServiceCtx, deviceId: string): boolean {
  const d = ctx.db.select({ status: devices.status, userId: devices.userId }).from(devices).where(eq(devices.id, deviceId)).get();
  return d?.status === 'approved' && d.userId !== null;
}

function exchangeAuthorizationCode(ctx: ServiceCtx, body: unknown, origin: string): IssuedTokens {
  const code = bodyParam(body, 'code', true);
  const verifier = bodyParam(body, 'code_verifier', true);
  const redirectUri = bodyParam(body, 'redirect_uri', true);
  const clientId = bodyParam(body, 'client_id', true);
  checkResource(body, origin);
  if (!getClient(ctx.db, clientId)) throw new OAuthError('invalid_client', undefined, 401);
  const { db, clock } = ctx;
  // Not throwing inside the transaction: the code must stay burned even when the exchange fails.
  const issued = db.$client.transaction((): IssuedTokens | undefined => {
    const codeHash = hashToken(code);
    const row = db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).get();
    if (!row) return undefined;
    db.delete(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).run();
    const valid =
      row.expiresAt > clock.now() &&
      row.clientId === clientId &&
      row.redirectUri === redirectUri &&
      VERIFIER_RE.test(verifier) &&
      pkceMatches(verifier, row.codeChallenge) &&
      isActiveDevice(ctx, row.deviceId);
    return valid ? issueTokens(ctx, row.deviceId) : undefined;
  })();
  if (!issued) throw new OAuthError('invalid_grant');
  return issued;
}

function refresh(ctx: ServiceCtx, body: unknown, origin: string, ip: string): IssuedTokens {
  const presented = bodyParam(body, 'refresh_token', true);
  checkResource(body, origin);
  const { db, clock } = ctx;
  let reusedDevice: string | undefined;
  const issued = db.$client.transaction((): IssuedTokens | undefined => {
    const row = db
      .select()
      .from(tokens)
      .where(and(eq(tokens.tokenHash, hashToken(presented)), eq(tokens.kind, 'refresh')))
      .get();
    if (!row) return undefined;
    if (row.revokedAt !== null) {
      reusedDevice = row.deviceId;
      return undefined;
    }
    if (row.expiresAt <= clock.now() || !isActiveDevice(ctx, row.deviceId)) return undefined;
    db.update(tokens).set({ revokedAt: clock.now() }).where(and(eq(tokens.id, row.id), isNull(tokens.revokedAt))).run();
    return issueTokens(ctx, row.deviceId);
  })();
  if (reusedDevice) revokeDevice(ctx, reusedDevice, { type: 'system', cause: 'refresh_reuse' }, { ip });
  if (!issued) throw new OAuthError('invalid_grant');
  return issued;
}

export function registerTokenRoute(app: FastifyInstance, deps: OAuthDeps): void {
  const { ctx, config } = deps;
  const origin = config.publicUrl.origin;
  app.post('/oauth/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const grantType = bodyParam(req.body, 'grant_type', true);
    let issued: IssuedTokens;
    if (grantType === 'authorization_code') issued = exchangeAuthorizationCode(ctx, req.body, origin);
    else if (grantType === 'refresh_token') issued = refresh(ctx, req.body, origin, req.ip);
    else if (grantType === DEVICE_CODE_GRANT) {
      const deviceCode = bodyParam(req.body, 'device_code', true);
      issued = pollDeviceCode(ctx, deps.polls, deviceCode, (deviceId) => issueTokens(ctx, deviceId));
    } else throw new OAuthError('unsupported_grant_type');
    return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(tokenResponse(issued));
  });
}
