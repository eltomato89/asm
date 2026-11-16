import { SecretMetaSchema } from '@asm/shared';
import { describe, expect, it } from 'vitest';
import { passkeys } from '../src/db/schema.js';
import { createSecret } from '../src/secrets/service.js';
import { PW, addDevice, login, world } from './helpers/fixtures.js';

const NEW_PW = 'a brand new long password';

async function loginStatus(app: Awaited<ReturnType<typeof world>>['app'], username: string, password: string) {
  return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).statusCode;
}

describe('POST /api/auth/password', () => {
  it('changes the password with the current one and ends all other sessions of the user', async () => {
    const w = await world();
    const otherSession = await login(w.app, 'alice');
    const bobBefore = w.bob.cookie;

    const wrong = await w.req(w.alice, 'POST', '/api/auth/password', { currentPassword: 'nope nope nope', newPassword: NEW_PW });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' });
    const missing = await w.req(w.alice, 'POST', '/api/auth/password', { newPassword: NEW_PW });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'current_password_required' });
    const short = await w.req(w.alice, 'POST', '/api/auth/password', { currentPassword: PW, newPassword: 'short' });
    expect(short.statusCode).toBe(400);

    const ok = await w.req(w.alice, 'POST', '/api/auth/password', { currentPassword: PW, newPassword: NEW_PW });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    // current session survives, the other one of alice is gone, bob is untouched
    expect((await w.req(w.alice, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await w.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: otherSession } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: bobBefore } })).statusCode).toBe(200);

    expect(await loginStatus(w.app, 'alice', PW)).toBe(401);
    expect(await loginStatus(w.app, 'alice', NEW_PW)).toBe(200);
  });

  it('lets a password-less user set one without currentPassword', async () => {
    const w = await world();
    w.db.$client.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(w.bob.id);
    const ok = await w.req(w.bob, 'POST', '/api/auth/password', { newPassword: NEW_PW });
    expect(ok.statusCode).toBe(200);
    expect(await loginStatus(w.app, 'bob', NEW_PW)).toBe(200);
  });

  it('needs a recent authentication', async () => {
    const w = await world();
    w.clock.advance(11 * 60_000);
    const r = await w.req(w.alice, 'POST', '/api/auth/password', { currentPassword: PW, newPassword: NEW_PW });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
  });
});

describe('PATCH /api/auth/passkeys/:id', () => {
  it('renames own passkeys only and validates the name', async () => {
    const w = await world();
    const row = (id: string, userId: string) => ({ id, userId, credentialId: `cred-${id}`, publicKey: Buffer.from([1]), counter: 0, transports: null, name: 'Passkey', createdAt: 1 });
    w.db.insert(passkeys).values(row('pky_a', w.alice.id)).run();
    w.db.insert(passkeys).values(row('pky_b', w.bob.id)).run();

    const ok = await w.req(w.alice, 'PATCH', '/api/auth/passkeys/pky_a', { name: '  MacBook Touch ID ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: 'pky_a', name: 'MacBook Touch ID', createdAt: 1, transports: null });
    expect((await w.req(w.alice, 'PATCH', '/api/auth/passkeys/pky_b', { name: 'x' })).statusCode).toBe(404);
    expect((await w.req(w.alice, 'PATCH', '/api/auth/passkeys/pky_a', { name: '' })).statusCode).toBe(400);
    expect((await w.req(w.alice, 'PATCH', '/api/auth/passkeys/pky_a', { name: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});

describe('GET /api/admin/users', () => {
  it('lists users for admins with passkey count and password flag, never hashes', async () => {
    const w = await world();
    w.db.insert(passkeys).values({ id: 'pky_1', userId: w.bob.id, credentialId: 'c1', publicKey: Buffer.from([1]), counter: 0, transports: null, name: 'p', createdAt: 1 }).run();
    const r = await w.req(w.alice, 'GET', '/api/admin/users');
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Record<string, unknown>[];
    expect(items.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'disabledAt', 'hasPassword', 'id', 'isAdmin', 'passkeyCount', 'username']);
    expect(items[1]).toMatchObject({ id: w.bob.id, isAdmin: false, passkeyCount: 1, hasPassword: true });
    expect((await w.req(w.bob, 'GET', '/api/admin/users')).statusCode).toBe(403);
  });
});

describe('GET /api/secrets paging and createdBy', () => {
  it('pages with a cursor (limit ≤ 200) and reports who created each secret', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      w.clock.advance(1000);
      ids.push(createSecret(w.ctx, w.alice.actor, { title: `S${i}`, value: 'v' }).id);
    }
    const dev = addDevice(w.db, w.alice.id, 'claude@mbp');
    w.clock.advance(1000);
    const agent = createSecret(w.ctx, dev, { title: 'Agent', value: 'v', project: 'asm', reason: 'needed' });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await w.req(w.alice, 'GET', `/api/secrets?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: unknown[]; nextCursor?: string };
      for (const it of body.items) seen.push(SecretMetaSchema.parse(it).id);
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([agent.id, ...[...ids].reverse()]);

    const all = (await w.req(w.alice, 'GET', '/api/secrets')).json();
    expect(all.nextCursor).toBeUndefined();
    const byId = new Map((all.items as { id: string; createdBy: unknown }[]).map((s) => [s.id, s.createdBy]));
    expect(byId.get(agent.id)).toEqual({ type: 'device', id: dev.deviceId, name: 'claude@mbp' });
    expect(byId.get(ids[0]!)).toEqual({ type: 'user', id: w.alice.id, name: 'alice' });

    expect((await w.req(w.alice, 'GET', '/api/secrets?limit=201')).statusCode).toBe(400);
    expect((await w.req(w.alice, 'GET', '/api/secrets?cursor=garbage')).statusCode).toBe(400);
  });
});

