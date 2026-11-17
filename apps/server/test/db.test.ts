import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const TABLES = [
  'users', 'passkeys', 'sessions', 'vaults', 'vault_members', 'secrets', 'secret_versions',
  'secrets_fts', 'devices', 'oauth_clients', 'oauth_codes', 'device_codes', 'tokens',
  'access_requests', 'grants', 'projects', 'project_usage', 'auto_mode', 'audit_log',
  'standing_approvals', 'standing_approval_secrets', 'standing_approval_vaults',
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
  (db.$client.prepare('SELECT secret_id AS id FROM secrets_fts WHERE secrets_fts MATCH ?').all(q) as { id: string }[]).map((r) => r.id);

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

  it('indexes env_name and keeps it exact on update', () => {
    const db = openDb(':memory:');
    seed(db);
    insertSecret(db);
    expect(fts(db, '"GH_TOKEN"*')).toEqual(['sec_1']);
    db.$client.prepare("UPDATE secrets SET env_name = 'NPM_TOKEN' WHERE id = 'sec_1'").run();
    expect(fts(db, '"GH_TOKEN"*')).toEqual([]);
    expect(fts(db, '"NPM_TOKEN"*')).toEqual(['sec_1']);
  });

  it('migration 0001 backfills env_name into the FTS index of an existing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asm-mig-'));
    try {
      // Database created with only the initial migration (as on a machine that ran a pre-0001 build).
      const src = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
      const only0 = join(dir, 'migrations');
      cpSync(src, only0, { recursive: true });
      const journalPath = join(only0, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag === '0000_init');
      writeFileSync(journalPath, JSON.stringify(journal));
      const file = join(dir, 'asm.db');
      const raw = new Database(file);
      migrate(drizzle(raw, { schema }), { migrationsFolder: only0 });
      raw.prepare("INSERT INTO users (id, username, is_admin, created_at) VALUES ('usr_1', 'alice', 1, 1)").run();
      raw.prepare("INSERT INTO vaults (id, name, created_at) VALUES ('vlt_1', 'V', 1)").run();
      raw
        .prepare(
          `INSERT INTO secrets (id, vault_id, title, description, tags, env_name, current_version, created_by_type, created_by_id, created_at, updated_at)
           VALUES ('sec_old', 'vlt_1', 'Deploy credentials', '', '[]', 'GITHUB_TOKEN', 1, 'user', 'usr_1', 1, 1)`,
        )
        .run();
      raw.close();

      const db = openDb(file);
      expect(fts(db, '"GITHUB_TOKEN"*')).toEqual(['sec_old']);
      expect(fts(db, 'deploy')).toEqual(['sec_old']);
      db.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration 0004 backfills auto_source for auto-approved requests and defaults standing_renewal to 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asm-mig-'));
    try {
      const src = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
      const upTo3 = join(dir, 'migrations');
      cpSync(src, upTo3, { recursive: true });
      const journalPath = join(upTo3, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.tag < '0004');
      writeFileSync(journalPath, JSON.stringify(journal));
      const file = join(dir, 'asm.db');
      const raw = new Database(file);
      migrate(drizzle(raw, { schema }), { migrationsFolder: upTo3 });
      raw.prepare("INSERT INTO users (id, username, is_admin, created_at) VALUES ('usr_1', 'alice', 1, 1)").run();
      raw.prepare("INSERT INTO vaults (id, name, created_at) VALUES ('vlt_1', 'V', 1)").run();
      raw
        .prepare(
          `INSERT INTO secrets (id, vault_id, title, description, tags, env_name, current_version, created_by_type, created_by_id, created_at, updated_at)
           VALUES ('sec_1', 'vlt_1', 'T', '', '[]', NULL, 1, 'user', 'usr_1', 1, 1)`,
        )
        .run();
      raw.prepare("INSERT INTO devices (id, user_id, name, kind, status, created_at) VALUES ('dev_1', 'usr_1', 'd', 'mcp', 'approved', 1)").run();
      const ins = raw.prepare(
        `INSERT INTO access_requests (id, kind, secret_id, device_id, user_id, project, reason, delivery, status, auto, created_at, expires_at)
         VALUES (?, 'read', 'sec_1', 'dev_1', 'usr_1', 'p', 'r', 'cli', ?, ?, 1, 2)`,
      );
      ins.run('req_auto', 'approved', 1);
      ins.run('req_manual', 'approved', 0);
      ins.run('req_pending', 'pending', 0);
      raw.close();

      const db = openDb(file);
      const rows = db.$client.prepare('SELECT id, auto_source, standing_renewal FROM access_requests ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'req_auto', auto_source: 'automode', standing_renewal: 0 },
        { id: 'req_manual', auto_source: null, standing_renewal: 0 },
        { id: 'req_pending', auto_source: null, standing_renewal: 0 },
      ]);
      db.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('standing approval rows cascade with the device and the secret', () => {
    const db = openDb(':memory:');
    seed(db);
    insertSecret(db);
    db.$client.prepare("INSERT INTO devices (id, user_id, name, kind, status, created_at) VALUES ('dev_1', 'usr_1', 'd', 'mcp', 'approved', 1)").run();
    db.insert(schema.standingApprovals).values({ deviceId: 'dev_1', userId: 'usr_1', until: 10, grantedAt: 1, scope: 'list', createdAt: 1, updatedAt: 1 }).run();
    db.insert(schema.standingApprovalSecrets).values({ deviceId: 'dev_1', secretId: 'sec_1', addedBy: 'user', addedAt: 1 }).run();
    const n = (t: string) => (db.$client.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    db.$client.prepare("DELETE FROM secrets WHERE id = 'sec_1'").run();
    expect(n('standing_approval_secrets')).toBe(0);
    expect(n('standing_approvals')).toBe(1);
    db.insert(schema.standingApprovalVaults).values({ deviceId: 'dev_1', vaultId: 'vlt_1', addedAt: 1 }).run();
    expect(n('standing_approval_vaults')).toBe(1);
    db.$client.prepare("DELETE FROM devices WHERE id = 'dev_1'").run();
    expect(n('standing_approvals')).toBe(0);
    expect(n('standing_approval_vaults')).toBe(0);
  });

  it('standing approval vault rows cascade with the vault', () => {
    const db = openDb(':memory:');
    seed(db);
    db.$client.prepare("INSERT INTO devices (id, user_id, name, kind, status, created_at) VALUES ('dev_1', 'usr_1', 'd', 'mcp', 'approved', 1)").run();
    db.insert(schema.standingApprovals).values({ deviceId: 'dev_1', userId: 'usr_1', until: 10, grantedAt: 1, scope: 'vaults', createdAt: 1, updatedAt: 1 }).run();
    db.insert(schema.standingApprovalVaults).values({ deviceId: 'dev_1', vaultId: 'vlt_1', addedAt: 1 }).run();
    const n = (t: string) => (db.$client.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    db.$client.prepare("DELETE FROM vaults WHERE id = 'vlt_1'").run();
    expect(n('standing_approval_vaults')).toBe(0);
    expect(n('standing_approvals')).toBe(1);
  });

  it('survives VACUUM with correct secret_id', () => {
    const db = openDb(':memory:');
    seed(db);
    insertSecret(db, 'sec_1');
    insertSecret(db, 'sec_2');
    db.$client.prepare("DELETE FROM secrets WHERE id = 'sec_1'").run();
    db.$client.exec('VACUUM');
    expect(fts(db, 'github')).toEqual(['sec_2']);
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
