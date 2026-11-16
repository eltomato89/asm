import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';

export type LockOptions = { staleMs?: number; retryMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-process lock via an O_EXCL lock file. A lock older than `staleMs` (crashed holder) is broken.
 * Returns the release function.
 */
export async function acquireLock(path: string, opts: LockOptions = {}): Promise<() => void> {
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = opts.retryMs ?? 50;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // already gone (broken as stale)
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
    } catch {
      // released meanwhile
    }
    await sleep(retryMs + Math.floor(Math.random() * retryMs));
  }
}
