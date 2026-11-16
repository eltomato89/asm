import { describe, expect, it } from 'vitest';
import { appendAudit } from '../src/audit/audit.js';
import { createSecret } from '../src/secrets/service.js';
import { world } from './helpers/fixtures.js';

describe('audit routes', () => {
  it('GET /api/audit filters and paginates; users only see their own rows', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    createSecret(w.ctx, w.alice.actor, { title: 'U', value: 'v' });
    const all = (await w.req(w.alice, 'GET', '/api/audit')).json();
    expect(all.items.map((r: { event: string }) => r.event)).toContain('secret.created');
    const one = (await w.req(w.alice, 'GET', `/api/audit?secretId=${s.id}`)).json();
    expect(one.items).toHaveLength(1);
    const page = (await w.req(w.alice, 'GET', '/api/audit?event=secret.created&limit=1')).json();
    expect(page.items).toHaveLength(1);
    const next = (await w.req(w.alice, 'GET', `/api/audit?event=secret.created&limit=1&cursor=${page.nextCursor}`)).json();
    expect(next.items[0].seq).toBeLessThan(page.items[0].seq);
    expect(next.nextCursor).toBeUndefined();
    const bobs = (await w.req(w.bob, 'GET', '/api/audit')).json().items as { secretId: string | null }[];
    expect(bobs.some((r) => r.secretId === s.id)).toBe(false);
    expect((await w.req(w.alice, 'GET', '/api/audit?cursor=abc')).statusCode).toBe(400);
    expect((await w.req(undefined, 'GET', '/api/audit')).statusCode).toBe(401);
  });

  it('admins additionally see system-actor rows (login failures), users do not', async () => {
    const w = await world();
    await w.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'whatever-pass' } });
    const admin = (await w.req(w.alice, 'GET', '/api/audit?event=auth.login_failed')).json().items;
    expect(admin).toHaveLength(1);
    expect((await w.req(w.bob, 'GET', '/api/audit?event=auth.login_failed')).json().items).toHaveLength(0);
  });

  it('CSV export: header, RFC 4180 quoting, formula-injection guard', async () => {
    const w = await world();
    appendAudit(w.db, w.clock, {
      actorType: 'user', actorId: w.alice.id, event: 'secret.archived', reason: '=HYPERLINK("http://x")', project: 'a,b', meta: { note: 'line1\nline2' },
    });
    const r = await w.req(w.alice, 'GET', '/api/audit.csv');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="audit.csv"/);
    const lines = r.body.split('\r\n');
    expect(lines[0]).toBe('seq,id,ts,actor_type,actor_id,event,secret_id,vault_id,device_id,project,reason,ip,meta');
    expect(r.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(r.body).toContain('"a,b"');
    expect(r.body).toContain('"{""note"":""line1\\nline2""}"');
    expect(r.body).not.toMatch(/,=HYPERLINK/);
  });

  it('verify is admin-only', async () => {
    const w = await world();
    expect((await w.req(w.alice, 'GET', '/api/audit/verify')).json()).toEqual({ ok: true });
    expect((await w.req(w.bob, 'GET', '/api/audit/verify')).statusCode).toBe(403);
  });
});
