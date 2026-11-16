import { describe, expect, it } from 'vitest';
import { appendAudit } from '../src/audit/audit.js';
import { mergeProjects } from '../src/projects/service.js';
import { createSecret } from '../src/secrets/service.js';
import { addDevice, world } from './helpers/fixtures.js';

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

  it('admins do not see system rows tied to another user\'s vault or secret', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.bob.actor, { title: 'Bob private', value: 'v' });
    appendAudit(w.db, w.clock, { actorType: 'system', actorId: null, event: 'request.expired', vaultId: w.bob.personalVaultId, reason: 'bob-private-reason' });
    appendAudit(w.db, w.clock, { actorType: 'system', actorId: null, event: 'request.denied', secretId: s.id, project: 'bob-proj' });
    const admin = await w.req(w.alice, 'GET', '/api/audit');
    expect(admin.body).not.toContain('bob-private-reason');
    expect(admin.body).not.toContain('bob-proj');
    expect((await w.req(w.alice, 'GET', '/api/audit.csv')).body).not.toContain('bob-private-reason');
    // bob still sees the vault-scoped one
    const bobs = (await w.req(w.bob, 'GET', '/api/audit')).json().items as { event: string }[];
    expect(bobs.map((r) => r.event)).toContain('request.expired');
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
    expect(r.headers['x-truncated']).toBeUndefined();
  });

  it('CSV guard also covers leading tab / CR; 10 000-row cap sets X-Truncated', async () => {
    const w = await world();
    appendAudit(w.db, w.clock, { actorType: 'user', actorId: w.alice.id, event: 'secret.archived', reason: '\t=1+1', project: '\r@SUM(A1)' });
    const r1 = await w.req(w.alice, 'GET', '/api/audit.csv');
    expect(r1.body).toContain(",'\t=1+1,");
    expect(r1.body).toContain(`"'\r@SUM(A1)"`);

    const ins = w.db.$client.prepare(
      `INSERT INTO audit_log (id, ts, actor_type, actor_id, event, prev_hash, hash) VALUES (?, 0, 'user', ?, 'auth.login', '', '')`,
    );
    w.db.$client.transaction(() => {
      for (let i = 0; i < 10_050; i++) ins.run(`aud_bulk_${i}`, w.alice.id);
    })();
    const r2 = await w.req(w.alice, 'GET', '/api/audit.csv');
    expect(r2.headers['x-truncated']).toBe('true');
    expect(r2.body.trimEnd().split('\r\n')).toHaveLength(10_001);
  });

  it('verify is admin-only', async () => {
    const w = await world();
    expect((await w.req(w.alice, 'GET', '/api/audit/verify')).json()).toEqual({ ok: true });
    expect((await w.req(w.bob, 'GET', '/api/audit/verify')).statusCode).toBe(403);
  });

  it('project filter includes rows written under projects merged (transitively) into the selected one', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    const a = createSecret(w.ctx, dev, { title: 'A', value: 'v', project: 'proj-a', reason: 'r' });
    const b = createSecret(w.ctx, dev, { title: 'B', value: 'v', project: 'proj-b', reason: 'r' });
    const c = createSecret(w.ctx, dev, { title: 'C', value: 'v', project: 'proj-c', reason: 'r' });
    const other = createSecret(w.ctx, dev, { title: 'O', value: 'v', project: 'other', reason: 'r' });
    const id = (slug: string) => (w.db.$client.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as { id: string }).id;
    mergeProjects(w.ctx, w.alice.id, id('proj-a'), id('proj-b'));
    mergeProjects(w.ctx, w.alice.id, id('proj-b'), id('proj-c'));
    const secretsFor = async (slug: string) =>
      ((await w.req(w.alice, 'GET', `/api/audit?project=${slug}&event=secret.created`)).json().items as { secretId: string }[])
        .map((r) => r.secretId)
        .sort();
    expect(await secretsFor('proj-c')).toEqual([a.id, b.id, c.id].sort());
    // A merged slug resolves to its canonical project as well.
    expect(await secretsFor('proj-a')).toEqual([a.id, b.id, c.id].sort());
    expect(await secretsFor('other')).toEqual([other.id]);
    expect(await secretsFor('unknown-slug')).toEqual([]);
  });
});
