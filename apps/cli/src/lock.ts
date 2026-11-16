import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';

export type LockOptions = { staleMs?: number; retryMs?: number };

export const LOCK_STALE_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Breaks a stale lock: rename to a unique name (atomic; only one breaker wins), restore it if it turned out fresh. */
function breakStale(path: string, staleMs: number): void {
  const aside = `${path}.${randomBytes(8).toString('hex')}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return; // released or broken by someone else
  }
  try {
    if (Date.now() - statSync(aside).mtimeMs <= staleMs) {
      // A new holder created the lock between our check and the rename: put it back (unless yet another one exists).
      try {
        linkSync(aside, path);
      } catch {
        // path re-created meanwhile
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      // ignore
    }
  }
}

/**
 * Cross-process lock via an O_EXCL lock file holding a random nonce. A lock older than `staleMs` (crashed holder)
 * is broken. Returns the release function, which only removes the lock if it still holds our nonce.
 */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<() => void> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? 50;
  const nonce = randomBytes(16).toString('hex');
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, nonce);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (readOr(path) !== nonce) return; // broken as stale and taken over by someone else
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) breakStale(path, staleMs);
    } catch {
      // released meanwhile
    }
    await sleep(retryMs + Math.floor(Math.random() * retryMs));
  }
}
