import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@asm/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'asm_session';
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

export type Session = { id: string; userId: string; lastAuthAt: number; expiresAt: number; createdAt: number };
export type SessionUser = { id: string; username: string; isAdmin: boolean };

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, clock: Clock, userId: string): { token: string; session: Session } {
  const token = randomBytes(32).toString('base64url');
  const now = clock.now();
  const session: Session = { id: newId('ses'), userId, lastAuthAt: now, expiresAt: now + SESSION_TTL_MS, createdAt: now };
  db.insert(sessions).values({ ...session, tokenHash: hashToken(token) }).run();
  return { token, session };
}

export function findSession(db: Db, clock: Clock, token: string): { session: Session; user: SessionUser } | undefined {
  const row = db
    .select({
      session: { id: sessions.id, userId: sessions.userId, lastAuthAt: sessions.lastAuthAt, expiresAt: sessions.expiresAt, createdAt: sessions.createdAt },
      user: { id: users.id, username: users.username, isAdmin: users.isAdmin },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, clock.now())))
    .get();
  return row;
}

export function touchReauth(db: Db, clock: Clock, sessionId: string): void {
  db.update(sessions).set({ lastAuthAt: clock.now() }).where(eq(sessions.id, sessionId)).run();
}

export function deleteSession(db: Db, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}
