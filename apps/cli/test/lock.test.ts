import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';
import { tmp } from './helpers.js';

describe('acquireLock', () => {
  it('serializes holders; release removes only its own lock', async () => {
    const path = join(tmp(), 'x.lock');
    const order: string[] = [];
    const release1 = await acquireLock(path, { retryMs: 5 });
    const second = acquireLock(path, { retryMs: 5 }).then((rel) => {
      order.push('second');
      return rel;
    });
    await new Promise((r) => setTimeout(r, 50));
    order.push('first-release');
    release1();
    const release2 = await second;
    expect(order).toEqual(['first-release', 'second']);
    // Someone else's lock (different nonce) is not removed by a late release of ours.
    writeFileSync(path, 'someone-else');
    release2();
    expect(readFileSync(path, 'utf8')).toBe('someone-else');
  });

  it('breaks a stale lock; a late release by the stale holder keeps the new lock', async () => {
    const path = join(tmp(), 'x.lock');
    const stale = await acquireLock(path);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
    const fresh = await acquireLock(path, { staleMs: 30_000, retryMs: 5 });
    const nonce = readFileSync(path, 'utf8');
    stale();
    expect(readFileSync(path, 'utf8')).toBe(nonce);
    fresh();
    expect(existsSync(path)).toBe(false);
  });
});
