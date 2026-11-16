import { randomBytes } from 'node:crypto';
import { newId } from '@asm/shared';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { appendAudit } from '../audit/audit.js';
import type { Clock } from '../clock.js';
import { passkeys, users } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { requireUser } from './guards.js';
import { SESSION_COOKIE_ATTRS, createSession, deleteSession, setSessionCookie, touchReauth } from './sessions.js';

export const CHALLENGE_COOKIE = 'asm_webauthn';
export const CHALLENGE_TTL_MS = 5 * 60_000;
const RP_NAME = 'ASM';

export type StoredCredential = { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports?: string[] };

/** Thin seam over @simplewebauthn/server so tests can stub the verify functions. */
export interface WebAuthnAdapter {
  generateRegistrationOptions(opts: Parameters<typeof generateRegistrationOptions>[0]): ReturnType<typeof generateRegistrationOptions>;
  verifyRegistration(opts: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
  }): Promise<{ verified: boolean; credential?: StoredCredential }>;
  generateAuthenticationOptions(opts: Parameters<typeof generateAuthenticationOptions>[0]): ReturnType<typeof generateAuthenticationOptions>;
  verifyAuthentication(opts: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRPID: string;
    credential: StoredCredential;
  }): Promise<{ verified: boolean; newCounter: number }>;
}

export const realWebAuthn: WebAuthnAdapter = {
  generateRegistrationOptions: (o) => generateRegistrationOptions(o),
  generateAuthenticationOptions: (o) => generateAuthenticationOptions(o),
  async verifyRegistration(o) {
    const r = await verifyRegistrationResponse({ ...o, requireUserVerification: false });
    return r.verified ? { verified: true, credential: r.registrationInfo.credential } : { verified: false };
  },
  async verifyAuthentication(o) {
    const r = await verifyAuthenticationResponse({ ...o, requireUserVerification: false });
    return { verified: r.verified, newCounter: r.authenticationInfo.newCounter };
  },
};

type Purpose = 'register' | 'login' | 'reauth';
type Challenge = { challenge: string; purpose: Purpose; userId: string | null; expiresAt: number };

/** In-memory, single-use challenges bound to a random id carried in a short-lived cookie. */
export class ChallengeStore {
  private readonly map = new Map<string, Challenge>();
  constructor(private readonly clock: Clock) {}

  put(challenge: string, purpose: Purpose, userId: string | null): string {
    this.prune();
    const id = randomBytes(24).toString('base64url');
    this.map.set(id, { challenge, purpose, userId, expiresAt: this.clock.now() + CHALLENGE_TTL_MS });
    return id;
  }

  /** Always consumes the challenge; returns it only if purpose/user match and it has not expired. */
  take(id: string | undefined, purpose: Purpose, userId: string | null): string | undefined {
    if (!id) return undefined;
    const c = this.map.get(id);
    this.map.delete(id);
    if (!c || c.expiresAt <= this.clock.now() || c.purpose !== purpose || c.userId !== userId) return undefined;
    return c.challenge;
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [k, v] of this.map) if (v.expiresAt <= now) this.map.delete(k);
  }
}

const registerVerifyBody = z.object({ name: z.string().trim().min(1).max(100).optional(), response: z.record(z.string(), z.unknown()) });
const assertionBody = z.object({ response: z.object({ id: z.string().min(1).max(1024) }).passthrough() });

export function registerPasskeyRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  h: { limited: (nameOf: (req: FastifyRequest) => string) => object; checkOrigin: (req: FastifyRequest) => void },
): void {
  const { db, clock, config } = deps;
  const adapter = deps.webauthn ?? realWebAuthn;
  const rpID = config.publicUrl.hostname;
  const origin = config.publicUrl.origin;
  const challenges = new ChallengeStore(clock);
  const ipLimit = h.limited(() => '');
  const userLimit = h.limited((req) => req.user?.id ?? '');

  const CHALLENGE_ATTRS = { ...SESSION_COOKIE_ATTRS, path: '/api/auth' } as const;
  function issueChallenge(reply: FastifyReply, challenge: string, purpose: Purpose, userId: string | null): void {
    reply.setCookie(CHALLENGE_COOKIE, challenges.put(challenge, purpose, userId), { ...CHALLENGE_ATTRS, maxAge: CHALLENGE_TTL_MS / 1000 });
  }
  function takeChallenge(req: FastifyRequest, reply: FastifyReply, purpose: Purpose, userId: string | null): string | undefined {
    const c = challenges.take(req.cookies[CHALLENGE_COOKIE], purpose, userId);
    reply.clearCookie(CHALLENGE_COOKIE, CHALLENGE_ATTRS);
    return c;
  }
  const userPasskeys = (userId: string) => db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  const toCredential = (p: typeof passkeys.$inferSelect): StoredCredential => ({
    id: p.credentialId,
    publicKey: new Uint8Array(p.publicKey),
    counter: p.counter,
    ...(p.transports ? { transports: p.transports } : {}),
  });
  const failLogin = (req: FastifyRequest): never => {
    appendAudit(db, clock, { actorType: 'system', actorId: 'anonymous', event: 'auth.login_failed', ip: req.ip, meta: { method: 'passkey' } });
    throw new HttpError(401, 'invalid_credentials');
  };

  /** Verifies an assertion against the stored credential; false on any failure (bad signature, counter regression). */
  async function assertionValid(response: AuthenticationResponseJSON, expectedChallenge: string, row: typeof passkeys.$inferSelect): Promise<boolean> {
    let result;
    try {
      result = await adapter.verifyAuthentication({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential: toCredential(row) });
    } catch {
      return false;
    }
    if (!result.verified) return false;
    if (row.counter > 0 && result.newCounter <= row.counter) return false;
    db.update(passkeys).set({ counter: result.newCounter }).where(eq(passkeys.id, row.id)).run();
    return true;
  }

  // --- registration ---
  app.post('/api/auth/passkey/register/options', { preHandler: requireUser, config: userLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const user = req.user!;
    const options = await adapter.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: userPasskeys(user.id).map((p) => ({ id: p.credentialId, ...(p.transports ? { transports: p.transports } : {}) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    issueChallenge(reply, options.challenge, 'register', user.id);
    return options;
  });

  app.post('/api/auth/passkey/register/verify', { preHandler: requireUser, config: userLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const body = registerVerifyBody.parse(req.body);
    const user = req.user!;
    const expectedChallenge = takeChallenge(req, reply, 'register', user.id);
    if (!expectedChallenge) throw new HttpError(400, 'invalid_challenge');
    let result;
    try {
      result = await adapter.verifyRegistration({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch {
      throw new HttpError(400, 'verification_failed');
    }
    if (!result.verified || !result.credential) throw new HttpError(400, 'verification_failed');
    const cred = result.credential;
    if (db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, cred.id)).get()) {
      throw new HttpError(409, 'credential_exists');
    }
    const row = {
      id: newId('pky'),
      userId: user.id,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports ?? null,
      name: body.name ?? 'Passkey',
      createdAt: clock.now(),
    };
    db.insert(passkeys).values(row).run();
    return reply.status(201).send({ id: row.id, name: row.name, createdAt: row.createdAt, transports: row.transports });
  });

  // --- login (discoverable) ---
  app.post('/api/auth/passkey/login/options', { config: ipLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const options = await adapter.generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    issueChallenge(reply, options.challenge, 'login', null);
    return options;
  });

  app.post('/api/auth/passkey/login/verify', { config: ipLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const body = assertionBody.parse(req.body);
    const expectedChallenge = takeChallenge(req, reply, 'login', null);
    if (!expectedChallenge) return failLogin(req);
    const row = db.select().from(passkeys).where(eq(passkeys.credentialId, body.response.id)).get();
    if (!row) return failLogin(req);
    if (!(await assertionValid(body.response as unknown as AuthenticationResponseJSON, expectedChallenge, row))) return failLogin(req);
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) return failLogin(req);
    if (req.session) deleteSession(db, req.session.id);
    const { token } = createSession(db, clock, user.id);
    appendAudit(db, clock, { actorType: 'user', actorId: user.id, event: 'auth.login', ip: req.ip, meta: { method: 'passkey' } });
    setSessionCookie(reply, token);
    return { id: user.id, username: user.username, isAdmin: user.isAdmin };
  });

  // --- re-authentication ---
  app.post('/api/auth/reauth/passkey/options', { preHandler: requireUser, config: userLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const user = req.user!;
    const mine = userPasskeys(user.id);
    if (mine.length === 0) throw new HttpError(409, 'no_passkey');
    const options = await adapter.generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: mine.map((p) => ({ id: p.credentialId, ...(p.transports ? { transports: p.transports } : {}) })),
    });
    issueChallenge(reply, options.challenge, 'reauth', user.id);
    return options;
  });

  app.post('/api/auth/reauth/passkey/verify', { preHandler: requireUser, config: userLimit }, async (req, reply) => {
    h.checkOrigin(req);
    const body = assertionBody.parse(req.body);
    const user = req.user!;
    const expectedChallenge = takeChallenge(req, reply, 'reauth', user.id);
    const row = db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.credentialId, body.response.id), eq(passkeys.userId, user.id)))
      .get();
    if (!expectedChallenge || !row || !(await assertionValid(body.response as unknown as AuthenticationResponseJSON, expectedChallenge, row))) {
      throw new HttpError(401, 'invalid_credentials');
    }
    touchReauth(db, clock, req.session!.id);
    return { ok: true };
  });

  // --- management ---
  app.get('/api/auth/passkeys', { preHandler: requireUser }, async (req) =>
    userPasskeys(req.user!.id).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, transports: p.transports })),
  );

  app.delete('/api/auth/passkeys/:id', { preHandler: requireUser }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const userId = req.user!.id;
    const row = db.select().from(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).get();
    if (!row) throw new HttpError(404, 'not_found');
    const hasPassword = !!db.select({ p: users.passwordHash }).from(users).where(eq(users.id, userId)).get()?.p;
    const total = db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId)).get()?.n ?? 0;
    if (!hasPassword && total <= 1) throw new HttpError(409, 'last_credential');
    db.delete(passkeys).where(eq(passkeys.id, id)).run();
    return { ok: true };
  });
}
