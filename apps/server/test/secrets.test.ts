import { describe, expect, it } from 'vitest';
import { SecretHistorySchema, SecretMetaSchema } from '@asm/shared';
import { verifyChain } from '../src/audit/audit.js';
import { DecryptError, open } from '../src/crypto/envelope.js';
import { HttpError, ValidationError } from '../src/errors.js';
import {
  applySecretChange,
  archiveSecret,
  createSecret,
  deleteSecret,
  generateValue,
  revealSecret,
  searchSecrets,
  unarchiveSecret,
} from '../src/secrets/service.js';
import { listHistory, listVersions, restoreVersion } from '../src/secrets/versions.js';
import { FORBIDDEN_RESPONSE_KEYS, ORIGIN, addDevice, allKeys, auditRows, world } from './helpers/fixtures.js';

const MIN11 = 11 * 60_000;

async function rejects(p: unknown | Promise<unknown>, status: number, code?: string) {
  let err: unknown;
  try {
    await (typeof p === 'function' ? (p as () => unknown)() : p);
  } catch (e) {
    err = e;
  }
  expect(err, 'expected an error').toBeDefined();
  const s = err instanceof HttpError ? err.statusCode : err instanceof ValidationError || (err as Error).name === 'ZodError' ? 400 : 500;
  expect(s).toBe(status);
  if (code) expect((err as { code?: string }).code).toBe(code);
}

describe('secrets: access and routes', () => {
  it('B sees nothing of A\'s personal vault (search 0, GET 404); after sharing a vault B sees its secrets', async () => {
    const w = await world();
    const res = await w.req(w.alice, 'POST', '/api/secrets', { title: 'GitHub Token', description: 'git access', value: 's3cr3t-gh' });
    expect(res.statusCode).toBe(201);
    const meta = SecretMetaSchema.parse(res.json());
    expect(meta.vaultId).toBe(w.alice.personalVaultId);

    expect((await w.req(w.bob, 'GET', '/api/secrets')).json().items).toEqual([]);
    expect((await w.req(w.bob, 'GET', `/api/secrets/${meta.id}`)).statusCode).toBe(404);
    expect((await w.req(w.bob, 'POST', `/api/secrets/${meta.id}/reveal`)).statusCode).toBe(404);
    expect((await w.req(w.bob, 'PATCH', `/api/secrets/${meta.id}`, { title: 'x' })).statusCode).toBe(404);

    const v = (await w.req(w.alice, 'POST', '/api/vaults', { name: 'Team' })).json();
    const shared = (await w.req(w.alice, 'POST', '/api/secrets', { vaultId: v.id, title: 'Stripe Key', value: 'sk_live' })).json();
    expect((await w.req(w.bob, 'GET', `/api/secrets/${shared.id}`)).statusCode).toBe(404);
    expect((await w.req(w.alice, 'POST', `/api/vaults/${v.id}/members`, { username: 'bob' })).statusCode).toBe(200);
    const items = (await w.req(w.bob, 'GET', '/api/secrets')).json().items as { id: string }[];
    expect(items.map((i) => i.id)).toEqual([shared.id]);
    expect((await w.req(w.bob, 'GET', `/api/secrets/${shared.id}`)).statusCode).toBe(200);
  });

  it('search "git" finds "GitHub Token" via description prefix; vault filter; empty query -> all', async () => {
    const w = await world();
    const a = createSecret(w.ctx, w.alice.actor, { title: 'GitHub Token', description: 'für git push', value: 'x1' });
    createSecret(w.ctx, w.alice.actor, { title: 'Stripe', description: 'payments', tags: ['billing'], value: 'x2' });
    expect(searchSecrets(w.db, w.alice.id, 'git').map((s) => s.id)).toEqual([a.id]);
    expect(searchSecrets(w.db, w.alice.id, 'GIT tok').map((s) => s.id)).toEqual([a.id]);
    expect(searchSecrets(w.db, w.alice.id, 'bill').map((s) => s.title)).toEqual(['Stripe']);
    expect(searchSecrets(w.db, w.alice.id, '"git"* OR x')).toEqual([]);
    expect(searchSecrets(w.db, w.alice.id, '   ')).toHaveLength(2);
    expect(searchSecrets(w.db, w.alice.id, '', { vaultId: 'vlt_nope' })).toEqual([]);
    const r = await w.req(w.alice, 'GET', '/api/secrets?q=git');
    expect(r.json().items.map((s: { id: string }) => s.id)).toEqual([a.id]);
    expect(searchSecrets(w.db, w.bob.id, 'git')).toEqual([]);
  });

  it('search returns at most 50, newest first', async () => {
    const w = await world();
    for (let i = 0; i < 55; i++) {
      createSecret(w.ctx, w.alice.actor, { title: `Key ${i}`, value: 'v' });
      w.clock.advance(1);
    }
    const res = searchSecrets(w.db, w.alice.id, 'key');
    expect(res).toHaveLength(50);
    expect(res[0]!.title).toBe('Key 54');
  });

  it('GET responses never contain value/ciphertext fields', async () => {
    const w = await world();
    const s = (await w.req(w.alice, 'POST', '/api/secrets', { title: 'T', value: 'plain-value-123' })).json();
    await w.req(w.alice, 'PATCH', `/api/secrets/${s.id}`, { value: 'plain-value-456' });
    const urls = ['/api/secrets', `/api/secrets/${s.id}`, `/api/secrets/${s.id}/versions`, '/api/vaults', '/api/audit', `/api/secrets/${s.id}/projects`];
    for (const url of urls) {
      const r = await w.req(w.alice, 'GET', url);
      expect(r.statusCode, url).toBe(200);
      const keys = allKeys(r.json());
      for (const k of FORBIDDEN_RESPONSE_KEYS) expect(keys.has(k), `${url} has ${k}`).toBe(false);
      expect(r.body).not.toContain('plain-value');
    }
  });

  it('reveal requires recent auth; returns plaintext and writes audit', async () => {
    const w = await world();
    const s = (await w.req(w.alice, 'POST', '/api/secrets', { title: 'T', value: 'hunter2-value' })).json();
    const ok = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/reveal`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ value: 'hunter2-value' });
    const ev = auditRows(w.db, 'secret.revealed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_type: 'user', actor_id: w.alice.id, secret_id: s.id, vault_id: s.vaultId });
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain('hunter2');

    w.clock.advance(MIN11);
    const late = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/reveal`);
    expect(late.statusCode).toBe(401);
    expect(late.json()).toEqual({ error: 'reauth_required' });
    for (const url of [`/api/secrets/${s.id}/versions/1/reveal`, `/api/secrets/${s.id}/versions/1/restore`, `/api/secrets/${s.id}/unarchive`]) {
      expect((await w.req(w.alice, 'POST', url)).json(), url).toEqual({ error: 'reauth_required' });
    }
    expect(verifyChain(w.db)).toEqual({ ok: true });
  });

  it('validation: bad envName, tags, title, oversized value, both value+generate, unknown field -> 400', async () => {
    const w = await world();
    const bad = [
      { title: 'T', value: 'v', envName: 'lower_case' },
      { title: 'T', value: 'v', envName: '1ABC' },
      { title: '', value: 'v' },
      { title: 'T', value: 'v', tags: ['has space'] },
      { title: 'T', value: 'v', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { title: 'T', value: 'ä'.repeat(32 * 1024 + 1) },
      { title: 'T', value: 'v', generate: { length: 20 } },
      { title: 'T' },
      { title: 'T', generate: { length: 15 } },
      { title: 'T', generate: { length: 257 } },
      { title: 'T', value: 'v', bogus: 1 },
    ];
    for (const p of bad) expect((await w.req(w.alice, 'POST', '/api/secrets', p)).statusCode, JSON.stringify(p).slice(0, 60)).toBe(400);
    const good = await w.req(w.alice, 'POST', '/api/secrets', { title: 'T', value: 'v', envName: 'GITHUB_TOKEN', tags: ['ci', 'prod.eu', 'ü-1'] });
    expect(good.statusCode).toBe(201);
    expect((await w.req(w.alice, 'PATCH', `/api/secrets/${good.json().id}`, { envName: 'bad-name' })).statusCode).toBe(400);
    expect((await w.req(w.alice, 'POST', '/api/secrets', { title: 'T', value: 'v', vaultId: 'vlt_unknown' })).statusCode).toBe(404);
  });

  it('unauthenticated -> 401', async () => {
    const w = await world();
    expect((await w.req(undefined, 'GET', '/api/secrets')).statusCode).toBe(401);
    expect((await w.req(undefined, 'POST', '/api/secrets', { title: 'T', value: 'v' })).statusCode).toBe(401);
  });

  it('DELETE removes secret with versions; device actor cannot delete', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    const dev = addDevice(w.db, w.alice.id);
    await rejects(() => deleteSecret(w.ctx, dev, s.id), 403, 'forbidden_for_device');
    expect((await w.req(w.bob, 'DELETE', `/api/secrets/${s.id}`)).statusCode).toBe(404);
    expect((await w.req(w.alice, 'DELETE', `/api/secrets/${s.id}`)).statusCode).toBe(200);
    expect((await w.req(w.alice, 'GET', `/api/secrets/${s.id}`)).statusCode).toBe(404);
    expect(w.db.$client.prepare('SELECT count(*) n FROM secret_versions').get()).toEqual({ n: 0 });
    expect(w.db.$client.prepare('SELECT count(*) n FROM secrets_fts').get()).toEqual({ n: 0 });
    expect(auditRows(w.db, 'secret.deleted')).toHaveLength(1);
  });

  it('DELETE requires recent auth', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    w.clock.advance(MIN11);
    const r = await w.req(w.alice, 'DELETE', `/api/secrets/${s.id}`);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'reauth_required' });
    expect((await w.req(w.alice, 'GET', `/api/secrets/${s.id}`)).statusCode).toBe(200);
  });
});

describe('secrets: versions', () => {
  it('create -> v1; two updates -> v1..3; reveal(1) = original; list has no values', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'DB', value: 'one' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'two' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'three', reason: 'rotation' });
    const versions = listVersions(w.db, w.alice.id, s.id);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
    expect(revealSecret(w.ctx, w.alice.actor, s.id, 1)).toBe('one');
    expect(revealSecret(w.ctx, w.alice.actor, s.id, 2)).toBe('two');
    expect(revealSecret(w.ctx, w.alice.actor, s.id)).toBe('three');
    expect(JSON.stringify(versions)).not.toMatch(/"one"|"two"|"three"/);
    expect(versions.find((v) => v.version === 3)).toMatchObject({ reason: 'rotation', changedBy: { type: 'user', id: w.alice.id, name: 'alice' } });
    expect(versions.find((v) => v.version === 1)!.metaDiff).toEqual({
      title: { from: null, to: 'DB' },
      description: { from: null, to: '' },
      tags: { from: null, to: [] },
      envName: { from: null, to: null },
    });
    expect(auditRows(w.db, 'secret.version_revealed')).toHaveLength(2);
    expect(auditRows(w.db, 'secret.updated')).toHaveLength(2);
  });

  it('metadata-only update creates a version with metaDiff and re-sealed unchanged value', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'Old', tags: ['a'], value: 'keep-me' });
    const m = applySecretChange(w.ctx, w.alice.actor, s.id, { meta: { title: 'New', tags: ['a', 'b'] } });
    expect(m.title).toBe('New');
    const v2 = listVersions(w.db, w.alice.id, s.id).find((v) => v.version === 2)!;
    expect(v2.metaDiff).toEqual({ title: { from: 'Old', to: 'New' }, tags: { from: ['a'], to: ['a', 'b'] } });
    expect(revealSecret(w.ctx, w.alice.actor, s.id, 2)).toBe('keep-me');
    const rows = w.db.$client.prepare('SELECT ciphertext FROM secret_versions WHERE secret_id = ? ORDER BY version').all(s.id) as { ciphertext: Buffer }[];
    expect(rows[0]!.ciphertext.equals(rows[1]!.ciphertext)).toBe(false);
    expect(searchSecrets(w.db, w.alice.id, 'new').map((x) => x.id)).toEqual([s.id]);
    expect(searchSecrets(w.db, w.alice.id, 'old')).toEqual([]);
    await rejects(() => applySecretChange(w.ctx, w.alice.actor, s.id, {}), 400, 'no_changes');
  });

  it('restore v1 -> v4 with old value/meta and restoredFrom 1 (route + audit)', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'First', value: 'v-one' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'v-two', meta: { title: 'Second' } });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'v-three' });
    const r = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/versions/1/restore`);
    expect(r.statusCode).toBe(200);
    expect(r.json().title).toBe('First');
    expect(revealSecret(w.ctx, w.alice.actor, s.id)).toBe('v-one');
    const hist = SecretHistorySchema.parse((await w.req(w.alice, 'GET', `/api/secrets/${s.id}/versions`)).json());
    const v4 = hist.versions.find((v) => v.version === 4)!;
    expect(v4.restoredFrom).toBe(1);
    expect(v4.metaDiff).toEqual({ title: { from: 'Second', to: 'First' } });
    expect(auditRows(w.db, 'secret.version_restored')[0]).toMatchObject({ secret_id: s.id });
    expect((await w.req(w.alice, 'POST', `/api/secrets/${s.id}/versions/9/restore`)).statusCode).toBe(404);
    const rv = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/versions/2/reveal`);
    expect(rv.json()).toEqual({ value: 'v-two' });
    const dev = addDevice(w.db, w.alice.id);
    await rejects(() => restoreVersion(w.ctx, dev, s.id, 1), 403, 'forbidden_for_device');
    await rejects(() => revealSecret(w.ctx, dev, s.id), 403, 'forbidden_for_device');
  });

  it('version ciphertext is bound to its version (AAD secretId:version)', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'a' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'b' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'c' });
    const row = w.db.$client
      .prepare('SELECT ciphertext, iv, tag, wrapped_dek wrappedDek, dek_iv dekIv, dek_tag dekTag FROM secret_versions WHERE secret_id = ? AND version = 2')
      .get(s.id) as Parameters<typeof open>[2];
    expect(open(w.ctx.kek, `${s.id}:2`, row)).toBe('b');
    expect(() => open(w.ctx.kek, `${s.id}:3`, row)).toThrow(DecryptError);
  });
});

describe('secrets: archive', () => {
  it('device archives with reason; hidden from default search; 409 twice; changes 409; user unarchives; versions kept', async () => {
    const w = await world();
    const hookCalls: string[] = [];
    w.ctx.hooks.onSecretArchived = (_c, id) => {
      hookCalls.push(id);
    };
    const dev = addDevice(w.db, w.alice.id);
    const s = createSecret(w.ctx, w.alice.actor, { title: 'Old API', value: 'v' });
    applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'v2' });

    await rejects(() => archiveSecret(w.ctx, dev, s.id, { reason: '', project: 'p' }), 400);
    await rejects(() => archiveSecret(w.ctx, dev, s.id, { reason: 'x' } as never), 400);
    const m = archiveSecret(w.ctx, dev, s.id, { reason: 'replaced by v2', project: 'MyApp' });
    expect(m.archived).toMatchObject({ reason: 'replaced by v2', project: 'my-app', by: { type: 'device', id: dev.deviceId, name: 'laptop-mcp' } });
    expect(hookCalls).toEqual([s.id]);
    expect(auditRows(w.db, 'secret.archived')[0]).toMatchObject({ actor_type: 'device', device_id: dev.deviceId, reason: 'replaced by v2', project: 'my-app' });

    expect(searchSecrets(w.db, w.alice.id, 'old')).toEqual([]);
    expect(searchSecrets(w.db, w.alice.id, 'old', { status: 'archived' }).map((x) => x.id)).toEqual([s.id]);
    expect(searchSecrets(w.db, w.alice.id, 'old', { includeArchived: true }).map((x) => x.id)).toEqual([s.id]);
    expect((await w.req(w.alice, 'GET', '/api/secrets?status=archived')).json().items).toHaveLength(1);
    expect((await w.req(w.alice, 'GET', '/api/secrets')).json().items).toHaveLength(0);

    await rejects(() => archiveSecret(w.ctx, w.alice.actor, s.id, { reason: 'again' }), 409, 'already_archived');
    await rejects(() => applySecretChange(w.ctx, w.alice.actor, s.id, { value: 'nope' }), 409, 'secret_archived');
    await rejects(() => revealSecret(w.ctx, w.alice.actor, s.id), 409, 'secret_archived');
    await rejects(() => unarchiveSecret(w.ctx, dev, s.id), 403, 'forbidden_for_device');

    const un = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/unarchive`);
    expect(un.statusCode).toBe(200);
    expect(un.json().archived).toBeNull();
    await rejects(() => unarchiveSecret(w.ctx, w.alice.actor, s.id), 409, 'not_archived');
    expect(listVersions(w.db, w.alice.id, s.id).map((v) => v.version).sort()).toEqual([1, 2]);
    const hist = listHistory(w.db, w.alice.id, s.id);
    expect(hist.events.map((e) => e.type)).toEqual(['archived', 'unarchived']);
    expect(hist.events[0]).toMatchObject({ reason: 'replaced by v2', project: 'my-app', by: { type: 'device', name: 'laptop-mcp' } });
  });

  it('archive route requires reason', async () => {
    const w = await world();
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    expect((await w.req(w.alice, 'POST', `/api/secrets/${s.id}/archive`, {})).statusCode).toBe(400);
    const ok = await w.req(w.alice, 'POST', `/api/secrets/${s.id}/archive`, { reason: 'unused' });
    expect(ok.statusCode).toBe(200);
    expect(SecretMetaSchema.parse(ok.json()).archived).toMatchObject({ reason: 'unused', project: null, by: { type: 'user', name: 'alice' } });
    expect((await w.req(w.alice, 'POST', `/api/secrets/${s.id}/archive`, { reason: 'x' })).json()).toEqual({ error: 'already_archived' });
  });
});

describe('secrets: device actor', () => {
  it('createSecret requires project and reason', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    await rejects(() => createSecret(w.ctx, dev, { title: 'T', value: 'v', reason: 'r' }), 400, 'project_required');
    await rejects(() => createSecret(w.ctx, dev, { title: 'T', value: 'v', project: 'p' }), 400, 'reason_required');
  });

  it('allowPlaintextToAgent in input -> 400 field_not_allowed, nothing written', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    for (const flag of [true, false]) {
      await rejects(
        () => createSecret(w.ctx, dev, { title: 'T', value: 'v', project: 'p', reason: 'r', allowPlaintextToAgent: flag }),
        400,
        'field_not_allowed',
      );
    }
    expect(w.db.$client.prepare('SELECT count(*) n FROM secrets').get()).toEqual({ n: 0 });
    expect(w.db.$client.prepare('SELECT count(*) n FROM projects').get()).toEqual({ n: 0 });
    expect(w.db.$client.prepare('SELECT count(*) n FROM audit_log WHERE event LIKE ?').get('secret.%')).toEqual({ n: 0 });
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    await rejects(
      () => applySecretChange(w.ctx, dev, s.id, { meta: { allowPlaintextToAgent: true }, project: 'p', reason: 'r' }),
      400,
      'field_not_allowed',
    );
  });

  it('generate {length: 32} -> 32 chars, defaults to personal vault, value never in any response; records usage', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    const m = createSecret(w.ctx, dev, { title: 'Generated', generate: { length: 32 }, project: 'AgentSecretsManager', reason: 'new api key' });
    expect(m.vaultId).toBe(w.alice.personalVaultId);
    expect(m.allowPlaintextToAgent).toBe(false);
    const value = revealSecret(w.ctx, w.alice.actor, m.id);
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(JSON.stringify(m)).not.toContain(value);
    for (const url of ['/api/secrets', `/api/secrets/${m.id}`, `/api/secrets/${m.id}/versions`, '/api/audit', `/api/secrets/${m.id}/projects`]) {
      expect((await w.req(w.alice, 'GET', url)).body, url).not.toContain(value);
    }
    expect(JSON.stringify(w.db.$client.prepare('SELECT * FROM audit_log').all())).not.toContain(value);
    const created = auditRows(w.db, 'secret.created')[0]!;
    expect(created).toMatchObject({ actor_type: 'device', device_id: dev.deviceId, project: 'agent-secrets-manager', reason: 'new api key' });
    expect(w.db.$client.prepare('SELECT count(*) n FROM project_usage').get()).toEqual({ n: 1 });
    expect(listVersions(w.db, w.alice.id, m.id)[0]).toMatchObject({ project: 'agent-secrets-manager', reason: 'new api key', changedBy: { type: 'device', name: 'laptop-mcp' } });
  });

  it('vault the device owner is not a member of -> 404', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    await rejects(
      () => createSecret(w.ctx, dev, { vaultId: w.bob.personalVaultId, title: 'T', value: 'v', project: 'p', reason: 'r' }),
      404,
    );
    const bobSecret = createSecret(w.ctx, w.bob.actor, { title: 'B', value: 'v' });
    await rejects(() => archiveSecret(w.ctx, dev, bobSecret.id, { reason: 'r', project: 'p' }), 404);
  });

  it('device archive requires project', async () => {
    const w = await world();
    const dev = addDevice(w.db, w.alice.id);
    const s = createSecret(w.ctx, w.alice.actor, { title: 'T', value: 'v' });
    await rejects(() => archiveSecret(w.ctx, dev, s.id, { reason: 'r' }), 400, 'project_required');
  });
});

describe('generateValue', () => {
  it('alphabets and bounds', () => {
    expect(generateValue(16, 'hex')).toMatch(/^[0-9a-f]{16}$/);
    expect(generateValue(256, 'base64url')).toMatch(/^[A-Za-z0-9_-]{256}$/);
    expect(generateValue(64, 'symbols')).toMatch(/^[A-Za-z0-9!#$%&*+\-=?@^_]{64}$/);
    expect(generateValue(20)).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(() => generateValue(15)).toThrow(ValidationError);
    expect(() => generateValue(257)).toThrow(ValidationError);
    expect(new Set(Array.from({ length: 20 }, () => generateValue(16))).size).toBe(20);
  });
});

describe('secrets: CSRF', () => {
  it('origin check applies to secret routes', async () => {
    const w = await world();
    const r = await w.app.inject({ method: 'POST', url: '/api/secrets', headers: { cookie: w.alice.cookie, origin: 'https://evil.test' }, payload: { title: 'T', value: 'v' } });
    expect(r.statusCode).toBe(403);
    expect(ORIGIN).toBe('https://asm.test');
  });
});
