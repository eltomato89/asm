import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import { FakeClock } from '../src/clock.js';
import { appendAudit, AuditCursorError, AuditMetaError, queryAudit, verifyChain } from '../src/audit/audit.js';

const ZERO = '0'.repeat(64);

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function three(db: Db, clock: FakeClock) {
  const a = appendAudit(db, clock, { actorType: 'user', actorId: 'usr_1', event: 'auth.login', ip: '1.2.3.4' });
  clock.advance(10);
  const b = appendAudit(db, clock, { actorType: 'device', actorId: 'dev_1', event: 'secret.created', secretId: 'sec_1', vaultId: 'vlt_1', project: 'p', meta: { b: 1, a: { z: 1, y: [1] } } });
  clock.advance(10);
  const c = appendAudit(db, clock, { actorType: 'system', actorId: null, event: 'request.expired', reason: 'r' });
  return [a, b, c] as const;
}

describe('audit log', () => {
  it('chains three entries and verifies', () => {
    const db = openDb(':memory:');
    const [a, b, c] = three(db, new FakeClock());
    expect(a.prevHash).toBe(ZERO);
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    expect(verifyChain(db)).toEqual({ ok: true });
    expect(a.id).toMatch(/^aud_/);
  });

  it('hash = sha256(prev_hash + canonical json without hash/seq)', () => {
    const db = openDb(':memory:');
    const [, b] = three(db, new FakeClock());
    const fields = {
      id: b.id, ts: b.ts, actor_type: b.actorType, actor_id: b.actorId, event: b.event,
      secret_id: b.secretId, vault_id: b.vaultId, device_id: b.deviceId, project: b.project,
      reason: b.reason, ip: b.ip, meta: b.meta, prev_hash: b.prevHash,
    };
    expect(b.hash).toBe(createHash('sha256').update(b.prevHash + canon(fields)).digest('hex'));
  });

  it('detects tampering with the correct seq', () => {
    const db = openDb(':memory:');
    const [, b] = three(db, new FakeClock());
    db.$client.prepare("UPDATE audit_log SET project = 'evil' WHERE id = ?").run(b.id);
    expect(verifyChain(db)).toEqual({ ok: false, brokenAtSeq: b.seq });
  });

  it('detects deleted entries', () => {
    const db = openDb(':memory:');
    const [, b, c] = three(db, new FakeClock());
    db.$client.prepare('DELETE FROM audit_log WHERE id = ?').run(b.id);
    expect(verifyChain(db)).toEqual({ ok: false, brokenAtSeq: c.seq });
  });

  it('rejects meta containing value/plaintext/secret keys, recursively', () => {
    const db = openDb(':memory:');
    const base = { actorType: 'user' as const, actorId: 'u', event: 'secret.created' as const };
    expect(() => appendAudit(db, new FakeClock(), { ...base, meta: { value: 'x' } })).toThrow(AuditMetaError);
    expect(() => appendAudit(db, new FakeClock(), { ...base, meta: { a: [{ Plaintext: 'x' }] } })).toThrow(AuditMetaError);
    expect(() => appendAudit(db, new FakeClock(), { ...base, meta: { n: { SECRET: 1 } } })).toThrow(AuditMetaError);
    expect(db.$client.prepare('SELECT count(*) c FROM audit_log').get()).toEqual({ c: 0 });
  });

  it('normalizes non-JSON-roundtrip meta so the chain still verifies', () => {
    const db = openDb(':memory:');
    const r = appendAudit(db, new FakeClock(), { actorType: 'system', actorId: null, event: 'auth.login', meta: { a: undefined, d: new Date(0) } });
    expect(r.meta).toEqual({ d: '1970-01-01T00:00:00.000Z' });
    expect(verifyChain(db)).toEqual({ ok: true });
  });

  it('rejects forbidden keys smuggled via toJSON', () => {
    const db = openDb(':memory:');
    const meta = { x: { toJSON: () => ({ value: 'leak' }) } };
    expect(() => appendAudit(db, new FakeClock(), { actorType: 'system', actorId: null, event: 'auth.login', meta })).toThrow(AuditMetaError);
  });

  it('works nested in an outer transaction and rolls back with it', () => {
    const db = openDb(':memory:');
    const clock = new FakeClock();
    const tx = db.$client.transaction(() => {
      appendAudit(db, clock, { actorType: 'system', actorId: null, event: 'auth.login' });
      appendAudit(db, clock, { actorType: 'system', actorId: null, event: 'auth.login' });
      throw new Error('boom');
    });
    expect(() => tx()).toThrow('boom');
    expect(db.$client.prepare('SELECT count(*) c FROM audit_log').get()).toEqual({ c: 0 });
    db.$client.transaction(() => appendAudit(db, clock, { actorType: 'system', actorId: null, event: 'auth.login' }))();
    expect(verifyChain(db)).toEqual({ ok: true });
  });

  describe('queryAudit', () => {
    function setup() {
      const db = openDb(':memory:');
      const clock = new FakeClock(1000);
      const r = db.$client;
      r.prepare("INSERT INTO users (id, username, is_admin, created_at) VALUES ('usr_1','a',1,1),('usr_2','b',0,1)").run();
      r.prepare("INSERT INTO vaults (id, name, created_at) VALUES ('vlt_1','V1',1),('vlt_2','V2',1)").run();
      r.prepare("INSERT INTO vault_members (vault_id, user_id, role) VALUES ('vlt_1','usr_1','owner'),('vlt_2','usr_2','owner')").run();
      r.prepare("INSERT INTO devices (id, user_id, name, kind, status, created_at) VALUES ('dev_1','usr_1','d','mcp','approved',1)").run();
      const e = (o: Parameters<typeof appendAudit>[2]) => { clock.advance(1); return appendAudit(db, clock, o); };
      const v1 = e({ actorType: 'device', actorId: 'dev_x', event: 'secret.created', vaultId: 'vlt_1', secretId: 'sec_1', project: 'alpha' });
      const v2 = e({ actorType: 'device', actorId: 'dev_x', event: 'secret.updated', vaultId: 'vlt_2', secretId: 'sec_2' });
      const own = e({ actorType: 'user', actorId: 'usr_1', event: 'auth.login' });
      const dev = e({ actorType: 'system', actorId: null, event: 'device.revoked', deviceId: 'dev_1' });
      const other = e({ actorType: 'user', actorId: 'usr_2', event: 'auth.login' });
      return { db, v1, v2, own, dev, other };
    }

    it('shows vault, own actor and own device entries, newest first', () => {
      const { db, v1, own, dev } = setup();
      const { items } = queryAudit(db, { userId: 'usr_1' });
      expect(items.map((i) => i.id)).toEqual([dev.id, own.id, v1.id]);
    });

    it('filters', () => {
      const { db, v1, own, dev } = setup();
      expect(queryAudit(db, { userId: 'usr_1', secretId: 'sec_1' }).items.map((i) => i.id)).toEqual([v1.id]);
      expect(queryAudit(db, { userId: 'usr_1', project: 'alpha' }).items.map((i) => i.id)).toEqual([v1.id]);
      expect(queryAudit(db, { userId: 'usr_1', deviceId: 'dev_1' }).items.map((i) => i.id)).toEqual([dev.id]);
      expect(queryAudit(db, { userId: 'usr_1', event: 'auth.login' }).items.map((i) => i.id)).toEqual([own.id]);
      expect(queryAudit(db, { userId: 'usr_1', from: own.ts, to: own.ts }).items.map((i) => i.id)).toEqual([own.id]);
    });

    it('rejects a non-numeric cursor', () => {
      const { db } = setup();
      expect(() => queryAudit(db, { userId: 'usr_1', cursor: 'abc' })).toThrow(AuditCursorError);
    });

    it('paginates with cursor', () => {
      const { db, v1, own, dev } = setup();
      const p1 = queryAudit(db, { userId: 'usr_1', limit: 2 });
      expect(p1.items.map((i) => i.id)).toEqual([dev.id, own.id]);
      expect(p1.nextCursor).toBe(String(own.seq));
      const p2 = queryAudit(db, { userId: 'usr_1', limit: 2, cursor: p1.nextCursor });
      expect(p2.items.map((i) => i.id)).toEqual([v1.id]);
      expect(p2.nextCursor).toBeUndefined();
    });
  });
});
