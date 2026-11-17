import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuditRow } from '../../lib/api';
import { formatDay } from '../../lib/format';
import type { Names } from '../../lib/names';
import { T0 } from '../../test/fixtures';
import { AUDIT_EVENTS, describeAudit, isAutoEvent } from './describe';

const names: Names = {
  meId: 'usr_1',
  device: (id) => (id === 'dev_1' ? 'claude@mbp-office' : undefined),
  secret: (id) => (id === 'sec_1' ? 'GITHUB_TOKEN' : undefined),
  vault: () => undefined,
  user: () => undefined,
};

const row = (over: Partial<AuditRow>): AuditRow => ({
  seq: 1,
  id: 'aud_1',
  ts: T0,
  actorType: 'user',
  actorId: 'usr_1',
  event: 'request.approved',
  secretId: null,
  vaultId: null,
  deviceId: 'dev_1',
  project: null,
  reason: null,
  ip: null,
  meta: null,
  prevHash: '0',
  hash: '1',
  ...over,
});

const text = (r: AuditRow) => {
  const d = describeAudit(r, names);
  const { container } = render(<>{d.sentence}</>);
  return { sentence: container.textContent, note: d.note, tone: d.tone };
};

const UNTIL = T0 + 7 * 86_400_000;

describe('describeAudit: standing approvals', () => {
  it('auto approval via standing approval vs. auto mode', () => {
    const base = { event: 'request.auto_approved', actorType: 'device' as const, actorId: 'dev_1', secretId: 'sec_1', project: 'asm' };
    expect(text(row({ ...base, meta: { via: 'standing' } })).sentence).toBe('claude@mbp-office received GITHUB_TOKEN for asm automatically (standing approval)');
    expect(text(row({ ...base, meta: { via: 'automode' } })).sentence).toBe('claude@mbp-office received GITHUB_TOKEN for asm automatically');
  });

  it('set: new vs. changed, scope and after-expiry note', () => {
    const meta = { until: UNTIL, scope: 'all', secretCount: 0, includeCreated: false, allowUpdates: false, afterExpiry: 'ask', renewDays: 7, previous: null };
    const a = text(row({ event: 'standing_approval.set', meta }));
    expect(a.sentence).toBe(`You set a standing approval for claude@mbp-office until ${formatDay(UNTIL)} (all secrets)`);
    expect(a.note).toBe('afterwards, every request asks again');
    expect(a.tone).toBe('amber');
    const b = text(row({ event: 'standing_approval.set', meta: { ...meta, scope: 'list', secretCount: 3, allowUpdates: true, afterExpiry: 'renew', renewDays: 30, previous: { until: T0 } } }));
    expect(b.sentence).toBe(`You changed the standing approval for claude@mbp-office, now until ${formatDay(UNTIL)} (3 secrets)`);
    expect(b.note).toBe('changes allowed too; the next request asks once to extend it by 30 days');
  });

  it('removed manually and on device revocation', () => {
    expect(text(row({ event: 'standing_approval.removed', meta: { cause: 'manual' } })).sentence).toBe('You removed the standing approval for claude@mbp-office');
    const revoked = text(row({ event: 'standing_approval.removed', actorType: 'system', actorId: null, meta: { cause: 'device_revoked' } }));
    expect(revoked.sentence).toBe('The standing approval for claude@mbp-office was removed');
    expect(revoked.note).toBe('device revoked');
  });

  it('renewed, expired and secret added', () => {
    const renewed = text(row({ event: 'standing_approval.renewed', meta: { requestId: 'req_1', previousUntil: T0, until: UNTIL, days: 7, via: 'push' } }));
    expect(renewed.sentence).toBe(`You extended the standing approval for claude@mbp-office by 7 days, until ${formatDay(UNTIL)}`);
    expect(renewed.note).toBe('via push');
    const expired = text(row({ event: 'standing_approval.expired', meta: { until: T0, afterExpiry: 'renew' } }));
    expect(expired.sentence).toBe('The standing approval for claude@mbp-office expired');
    expect(expired.note).toBe('the next request asks once to extend it');
    const added = text(row({ event: 'standing_approval.secret_added', actorType: 'device', actorId: 'dev_1', secretId: 'sec_1', meta: { cause: 'created_by_device' } }));
    expect(added.sentence).toBe('claude@mbp-office created GITHUB_TOKEN, which was added to its standing approval');
  });

  it('notes renewal requests and approvals that extended a standing approval', () => {
    expect(text(row({ event: 'request.created', actorType: 'device', actorId: 'dev_1', secretId: 'sec_1', meta: { kind: 'read', renewal: true } })).note).toBe(
      'standing approval expired',
    );
    expect(text(row({ event: 'request.approved', secretId: 'sec_1', meta: { renewed: 'true' } })).note).toBe('standing approval extended');
    expect(text(row({ event: 'request.approved', secretId: 'sec_1', meta: {} })).note).toBeUndefined();
  });

  it('lists the new events in the filter and marks them like auto events', () => {
    for (const e of ['set', 'removed', 'renewed', 'expired', 'secret_added']) {
      expect(AUDIT_EVENTS).toContain(`standing_approval.${e}`);
      expect(isAutoEvent(`standing_approval.${e}`)).toBe(true);
    }
  });
});
