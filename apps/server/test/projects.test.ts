import { describe, expect, it } from 'vitest';
import { ProjectDetailSchema, ProjectDtoSchema } from '@asm/shared';
import { ValidationError } from '../src/errors.js';
import { projectSlug } from '../src/projects/slug.js';
import { getProject, listProjects, mergeProjects, projectsForSecret, recordUsage, touchProject } from '../src/projects/service.js';
import { createSecret } from '../src/secrets/service.js';
import { addDevice, world } from './helpers/fixtures.js';

describe('projectSlug', () => {
  it('normalizes names', () => {
    expect(projectSlug('AgentSecretsManager')).toBe('agent-secrets-manager');
    expect(projectSlug('  My_App v2 ')).toBe('my-app-v2');
    expect(projectSlug('HTTPServer')).toBe('http-server');
    expect(projectSlug('--foo--bar--')).toBe('foo-bar');
    expect(projectSlug('a'.repeat(150))).toHaveLength(100);
    expect(projectSlug(`${'a'.repeat(99)}-b`)).toBe('a'.repeat(99));
    expect(() => projectSlug('---')).toThrow(ValidationError);
    expect(() => projectSlug('')).toThrow(ValidationError);
  });
});

describe('projects', () => {
  it('touchProject: same slug -> same project, updates last_seen', async () => {
    const w = await world();
    const a = touchProject(w.ctx, 'Foo');
    w.clock.advance(1000);
    const b = touchProject(w.ctx, 'foo');
    expect(b.id).toBe(a.id);
    expect(b.displayName).toBe('Foo');
    expect(b.lastSeen).toBe(a.firstSeen + 1000);
  });

  it('merge a -> b: touch(a) yields b, usages move, audit untouched, routes', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    const s1 = createSecret(w.ctx, dev, { title: 'S1', value: 'v', project: 'old-name', reason: 'r' });
    const s2 = createSecret(w.ctx, dev, { title: 'S2', value: 'v', project: 'NewName', reason: 'r' });
    const a = touchProject(w.ctx, 'old-name');
    const b = touchProject(w.ctx, 'NewName');
    const auditBefore = JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all());

    const bad = await w.req(w.alice, 'POST', `/api/projects/${a.id}/merge`, { into: a.id });
    expect(bad.statusCode).toBe(400);
    const res = await w.req(w.alice, 'POST', `/api/projects/${a.id}/merge`, { into: b.id });
    expect(res.statusCode).toBe(200);
    expect(ProjectDtoSchema.parse(res.json()).id).toBe(b.id);

    expect(touchProject(w.ctx, a.slug).id).toBe(b.id);
    const detail = getProject(w.db, w.alice.id, b.id);
    expect(detail.secrets.map((x) => x.secret.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(detail.devices.map((d) => d.device.id)).toEqual([dev.deviceId]);
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).toBe(auditBefore);

    // cycles are refused
    expect(() => mergeProjects(w.ctx, w.alice.id, b.id, a.id)).toThrow();
    const list = (await w.req(w.alice, 'GET', '/api/projects')).json().items as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([b.id]);
    expect(listProjects(w.db, w.alice.id).map((p) => p.slug)).toEqual(['new-name']);

    const viaRoute = await w.req(w.alice, 'GET', `/api/projects/${b.id}`);
    expect(ProjectDetailSchema.parse(viaRoute.json()).secrets).toHaveLength(2);
    const sp = (await w.req(w.alice, 'GET', `/api/secrets/${s1.id}/projects`)).json().items;
    expect(sp.map((x: { project: { id: string } }) => x.project.id)).toEqual([b.id]);
    expect((await w.req(w.bob, 'GET', `/api/secrets/${s1.id}/projects`)).statusCode).toBe(404);
    expect((await w.req(w.alice, 'GET', '/api/projects/prj_unknown')).statusCode).toBe(404);
  });

  it('merge requires recent auth', async () => {
    const w = await world();
    const a = touchProject(w.ctx, 'a');
    const b = touchProject(w.ctx, 'b');
    w.clock.advance(11 * 60_000);
    const r = await w.req(w.alice, 'POST', `/api/projects/${a.id}/merge`, { into: b.id });
    expect(r.json()).toEqual({ error: 'reauth_required' });
  });

  it('getProject shows B no secrets from A\'s vault', async () => {
    const w = await world();
    const devA = addDevice(w.db, w.alice.id);
    const devB = addDevice(w.db, w.bob.id, 'bob-cli');
    const sa = createSecret(w.ctx, devA, { title: 'A', value: 'v', project: 'shared-proj', reason: 'r' });
    const sb = createSecret(w.ctx, devB, { title: 'B', value: 'v', project: 'shared-proj', reason: 'r' });
    const p = touchProject(w.ctx, 'shared-proj');
    recordUsage(w.ctx, p.id, sa.id, devA.deviceId);
    const forBob = getProject(w.db, w.bob.id, p.id);
    expect(forBob.secrets.map((x) => x.secret.id)).toEqual([sb.id]);
    expect(forBob.devices.map((x) => x.device.id)).toEqual([devB.deviceId]);
    expect(getProject(w.db, w.alice.id, p.id).secrets.map((x) => x.secret.id)).toEqual([sa.id]);
    expect(() => projectsForSecret(w.db, w.bob.id, sa.id)).toThrow();
  });
});
