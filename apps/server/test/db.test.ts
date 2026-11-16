import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const TABLES = [
  'users', 'passkeys', 'sessions', 'vaults', 'vault_members', 'secrets', 'secret_versions',
  'secrets_fts', 'devices', 'oauth_clients', 'oauth_codes', 'device_codes', 'tokens',
  'access_requests', 'grants', 'projects', 'project_usage', 'auto_mode', 'audit_log',
];

function seed(db: Db) {
  db.insert(schema.users).values({ id: 'usr_1', username: 'alice', isAdmin: true, createdAt: 1 }).run();
  db.insert(schema.vaults).values({ id: 'vlt_1', name: 'V', createdAt: 1 }).run();
}

function insertSecret(db: Db, id = 'sec_1') {
  db.insert(schema.secrets).values({
    id, vaultId: 'vlt_1', title: 'GitHub token', description: 'ci deploy', tags: ['ci', 'prod'],
    envName: 'GH_TOKEN', currentVersion: 1, createdByType: 'user',
    createdById: 'usr_1', createdAt: 1, updatedAt: 1,
  }).run();
}

const fts = (db: Db, q: string): string[] =>
  (db.$client.prepare('SELECT s.id FROM secrets_fts f JOIN secrets s ON s.rowid = f.rowid WHERE secrets_fts MATCH ?').all(q) as { id: string }[]).map((r) => r.id);

describe('openDb', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = (db.$client.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('keeps fts index exact on insert, update, delete', () => {
    const db = openDb(':memory:');
    seed(db);
    insertSecret(db);
    expect(fts(db, 'github')).toEqual(['sec_1']);
    expect(fts(db, 'prod')).toEqual(['sec_1']);
    db.$client.prepare("UPDATE secrets SET description = 'staging rollout' WHERE id = 'sec_1'").run();
    expect(fts(db, 'deploy')).toEqual([]);
    expect(fts(db, 'staging')).toEqual(['sec_1']);
    db.$client.prepare("DELETE FROM secrets WHERE id = 'sec_1'").run();
    expect(fts(db, 'github')).toEqual([]);
    expect(fts(db, 'staging')).toEqual([]);
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    seed(db);
    expect(() => db.insert(schema.vaultMembers).values({ vaultId: 'nope', userId: 'usr_1', role: 'owner' }).run()).toThrow();
  });

  it('rejects duplicate (secret_id, version)', () => {
    const db = openDb(':memory:');
    seed(db);
    insertSecret(db);
    const v = {
      secretId: 'sec_1', version: 1, ciphertext: Buffer.from('a'), iv: Buffer.from('b'), tag: Buffer.from('c'),
      wrappedDek: Buffer.from('d'), dekIv: Buffer.from('e'), dekTag: Buffer.from('f'),
      metaSnapshot: { title: 't', description: 'd', tags: [], envName: null },
      changedByType: 'user' as const, changedById: 'usr_1', createdAt: 1,
    };
    db.insert(schema.secretVersions).values(v).run();
    expect(() => db.insert(schema.secretVersions).values(v).run()).toThrow();
    const row = db.select().from(schema.secretVersions).get();
    expect(Buffer.isBuffer(row?.ciphertext)).toBe(true);
    expect(row?.metaSnapshot.title).toBe('t');
  });
});
