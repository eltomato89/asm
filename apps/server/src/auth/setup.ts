import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from '@asm/shared';
import { count } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { users, vaultMembers, vaults } from '../db/schema.js';
import { HttpError, ValidationError } from '../errors.js';
import { hashPassword } from './password.js';

export const USERNAME_RE = /^[a-z0-9._-]+$/i;
export const MIN_PASSWORD_LENGTH = 12;

export interface SetupState {
  getToken(): string | undefined;
  verify(candidate: string): boolean;
  clear(): void;
  restore(token: string | undefined): void;
}

export function countUsers(db: Db): number {
  return db.select({ n: count() }).from(users).get()?.n ?? 0;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

/** Generates the one-time setup token only while no users exist; logs it once. */
export function createSetupState(db: Db, logger: Pick<Logger, 'warn'>): SetupState {
  let token: string | undefined;
  if (countUsers(db) === 0) {
    token = randomBytes(32).toString('base64url');
    logger.warn(`ASM setup token: ${token} (needed for the first admin setup; valid until the first user exists)`);
  }
  return {
    getToken: () => token,
    verify: (candidate) => token !== undefined && timingSafeEqual(sha(candidate), sha(token)),
    clear: () => {
      token = undefined;
    },
    restore: (t) => {
      token = t;
    },
  };
}

export type CreatedUser = { id: string; username: string; isAdmin: boolean; personalVaultId: string };

/** Inserts user + personal vault + owner membership atomically. Throws HttpError 409 on duplicate username. */
export async function createUser(
  db: Db,
  clock: Clock,
  input: { username: string; password?: string; isAdmin: boolean },
  opts: { onlyIfNoUsers?: boolean } = {},
): Promise<CreatedUser> {
  if (input.username.length < 3 || input.username.length > 64 || !USERNAME_RE.test(input.username)) {
    throw new ValidationError('invalid_username');
  }
  if (input.password !== undefined && (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 1024)) {
    throw new ValidationError('invalid_password');
  }
  const username = input.username.toLowerCase();
  const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
  const now = clock.now();
  const id = newId('usr');
  const vaultId = newId('vlt');
  try {
    db.$client.transaction(() => {
      if (opts.onlyIfNoUsers && countUsers(db) > 0) throw new HttpError(409, 'already_setup');
      db.insert(users).values({ id, username, passwordHash, isAdmin: input.isAdmin, createdAt: now }).run();
      db.insert(vaults).values({ id: vaultId, name: 'Personal', personalOfUserId: id, createdAt: now }).run();
      db.insert(vaultMembers).values({ vaultId, userId: id, role: 'owner' }).run();
    })();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'username_taken');
    throw e;
  }
  return { id, username, isAdmin: input.isAdmin, personalVaultId: vaultId };
}
