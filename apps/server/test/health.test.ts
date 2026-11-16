import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { createTestApp } from './helpers/testApp.js';

describe('GET /healthz', () => {
  it('returns 200 {"status":"ok"}', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('logger redaction', () => {
  it('redacts secret values and auth headers', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info({ secret: { value: 'hunter2', plaintext: 'p4ss' }, req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } } }, 'x');
    const out = lines.join('');
    for (const s of ['hunter2', 'p4ss', 'Bearer abc', 'sid=1']) expect(out).not.toContain(s);
  });
});

describe('FakeClock', () => {
  it('advances and sets', () => {
    const c = new FakeClock(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(7);
    expect(c.now()).toBe(7);
  });
});
