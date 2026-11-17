import { describe, expect, it } from 'vitest';
import { StandingApprovalInputSchema } from '@asm/shared';
import { createRequest, waitForRequest } from '../src/requests/service.js';
import { RequestEvents } from '../src/requests/events.js';
import { createSecret } from '../src/secrets/service.js';
import { setStandingApproval } from '../src/standing/service.js';
import { pairDevice, world } from './helpers/fixtures.js';

type Stream = { text: () => string; ended: () => boolean; close: () => void; status: number; contentType: string | null };

async function openStream(base: string, cookie: string): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ac.signal });
  let buf = '';
  let ended = false;
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch {
        /* aborted */
      }
      ended = true;
    })();
  }
  return { text: () => buf, ended: () => ended, close: () => ac.abort(), status: res.status, contentType: res.headers.get('content-type') };
}

async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('RequestEvents', () => {
  it('delivers per user and unsubscribes', () => {
    const ev = new RequestEvents();
    const got: string[] = [];
    const off = ev.subscribe('usr_a', (e) => got.push(`a:${e.type}`));
    ev.subscribe('usr_b', (e) => got.push(`b:${e.type}`));
    ev.emit('usr_a', { type: 'automode.changed', data: { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null } });
    off();
    ev.emit('usr_a', { type: 'automode.changed', data: { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null } });
    expect(got).toEqual(['a:automode.changed']);
  });
});

describe('waitForRequest', () => {
  it('ignores device.changed events and resolves only on the request transition', async () => {
    const w = await world();
    const secret = createSecret(w.ctx, w.alice.actor, { title: 'K', value: 'v' });
    const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
    const r = createRequest(w.ctx, { device: { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' });
    let done = false;
    const p = waitForRequest(w.ctx, r.id, deviceId, 200).then((dto) => {
      done = true;
      return dto;
    });
    w.ctx.events.emit(w.alice.id, { type: 'device.changed', data: { deviceId } });
    await new Promise((res) => setTimeout(res, 20));
    expect(done).toBe(false);
    expect((await p).status).toBe('pending');
  });
});

describe('SSE /api/events', () => {
  it('forwards device.changed to the owner', async () => {
    const w = await world();
    await w.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = w.app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const a = await openStream(base, w.alice.cookie);
    const b = await openStream(base, w.bob.cookie);
    try {
      const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
      setStandingApproval(w.ctx, w.alice.id, deviceId, StandingApprovalInputSchema.parse({ until: w.clock.now() + 86_400_000, scope: 'all' }), {});
      await until(() => a.text().includes('event: device.changed'));
      const frame = a.text().split('\n\n').find((f) => f.startsWith('event: device.changed'))!;
      expect(JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6))).toEqual({ deviceId });
      await new Promise((res) => setTimeout(res, 50));
      expect(b.text()).not.toContain('device.changed');
    } finally {
      await w.app.close();
      a.close();
      b.close();
    }
  });

  it('stream ends once its session is gone (logout) and delivers nothing further', async () => {
    const w = await world();
    await w.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = w.app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const a = await openStream(base, w.alice.cookie);
    try {
      expect(a.status).toBe(200);
      expect((await w.req(w.alice, 'POST', '/api/auth/logout')).statusCode).toBeLessThan(300);
      const secret = createSecret(w.ctx, w.alice.actor, { title: 'After logout', value: 'v' });
      const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
      createRequest(w.ctx, { device: { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli' });
      await until(() => a.ended());
      expect(a.text()).not.toContain('request.created');
    } finally {
      a.close();
      await w.app.close();
    }
  });

  it('streams request.created to the owner only; requires a session; max 10 streams per user', async () => {
    const w = await world();
    await w.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = w.app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const streams: Stream[] = [];
    try {
      expect((await fetch(`${base}/api/events`)).status).toBe(401);
      const a = await openStream(base, w.alice.cookie);
      const b = await openStream(base, w.bob.cookie);
      streams.push(a, b);
      expect(a.status).toBe(200);
      expect(a.contentType).toContain('text/event-stream');

      const secret = createSecret(w.ctx, w.alice.actor, { title: 'Stripe Key', value: 'sk_live_SSE' });
      const { deviceId } = pairDevice(w.ctx, { userId: w.alice.id, kind: 'mcp', name: 'agent' });
      const r = createRequest(w.ctx, {
        device: { id: deviceId, userId: w.alice.id, kind: 'mcp', name: 'agent' }, secretId: secret.id, project: 'p', reason: 'r', delivery: 'cli',
      });
      await until(() => a.text().includes('event: request.created'));
      const frame = a.text().split('\n\n').find((f) => f.startsWith('event: request.created'))!;
      const data = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
      expect(data).toMatchObject({ id: r.id, status: 'pending' });
      expect(a.text()).not.toContain('sk_live_SSE');

      await w.req(w.alice, 'POST', `/api/requests/${r.id}/decision`, { decision: 'deny' });
      await until(() => a.text().includes('event: request.updated'));
      await new Promise((res) => setTimeout(res, 50));
      expect(b.text()).not.toContain('request.');

      for (let i = 0; i < 9; i++) streams.push(await openStream(base, w.alice.cookie));
      const eleventh = await openStream(base, w.alice.cookie);
      streams.push(eleventh);
      expect(eleventh.status).toBe(429);
      // Closing one frees a slot.
      a.close();
      await new Promise((res) => setTimeout(res, 100));
      const again = await openStream(base, w.alice.cookie);
      streams.push(again);
      expect(again.status).toBe(200);
    } finally {
      // Open streams must not block shutdown.
      await w.app.close();
      for (const s of streams) s.close();
    }
  });
});
