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
  vault: (id) => (id === 'vlt_w' ? 'Work' : id === 'vlt_o' ? 'Ops' : undefined),
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
    const disabled = text(row({ event: 'standing_approval.removed', actorType: 'system', actorId: null, meta: { cause: 'disabled_by_admin' } }));
    expect(disabled.sentence).toBe('The standing approval for claude@mbp-office was removed');
    expect(disabled.note).toBe('standing approvals were turned off by the admin');
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

  it('standing approval for selected vaults: names when known, otherwise a count', () => {
    const meta = { until: UNTIL, scope: 'vaults', secretCount: 0, allowUpdates: false, afterExpiry: 'ask', renewDays: 7 };
    expect(text(row({ event: 'standing_approval.set', meta: { ...meta, vaultIds: ['vlt_w', 'vlt_o'], vaultCount: 2 } })).sentence).toBe(
      `You set a standing approval for claude@mbp-office until ${formatDay(UNTIL)} (vaults Work, Ops)`,
    );
    expect(text(row({ event: 'standing_approval.set', meta: { ...meta, vaultIds: ['vlt_w'], vaultCount: 1 } })).sentence).toBe(
      `You set a standing approval for claude@mbp-office until ${formatDay(UNTIL)} (vault Work)`,
    );
    expect(text(row({ event: 'standing_approval.set', meta: { ...meta, vaultIds: ['vlt_w', 'vlt_gone'], vaultCount: 2 } })).sentence).toBe(
      `You set a standing approval for claude@mbp-office until ${formatDay(UNTIL)} (2 vaults)`,
    );
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

describe('describeAudit: device default vault', () => {
  it('changed by the user, and reset after losing vault membership', () => {
    const set = text(row({ event: 'device.default_vault_changed', vaultId: 'vlt_w', meta: { previousVaultId: 'vlt_p', vaultId: 'vlt_w' } }));
    expect(set.sentence).toBe('You set the default vault of claude@mbp-office to Work');
    expect(set.note).toBeUndefined();
    const reset = text(
      row({ event: 'device.default_vault_changed', actorType: 'system', actorId: null, vaultId: 'vlt_p', meta: { cause: 'member_removed', previousVaultId: 'vlt_w', vaultId: null } }),
    );
    expect(reset.sentence).toBe('The default vault of claude@mbp-office was reset to Personal');
    expect(reset.note).toBe('no longer a member of the previous vault');
    expect(AUDIT_EVENTS).toContain('device.default_vault_changed');
  });
});

describe('describeAudit: linked devices', () => {
  const linkNames: Names = { ...names, device: (id) => ({ dev_1: 'claude@mbp-office', dev_cli: 'asm@mbp', dev_2: 'claude@studio' })[id ?? ''] };
  const linkText = (r: AuditRow) => {
    const d = describeAudit(r, linkNames);
    const { container } = render(<>{d.sentence}</>);
    return { sentence: container.textContent, note: d.note };
  };

  it('linked manually, during pairing and with dropped settings', () => {
    const plain = linkText(row({ event: 'device.linked', deviceId: 'dev_cli', meta: { mainDeviceId: 'dev_1', cause: 'manual', droppedStanding: false, previousDefaultVaultId: null } }));
    expect(plain.sentence).toBe('You linked asm@mbp to claude@mbp-office');
    expect(plain.note).toBeUndefined();
    const full = linkText(
      row({
        event: 'device.linked',
        deviceId: 'dev_cli',
        meta: { mainDeviceId: 'dev_1', previousMainDeviceId: 'dev_2', cause: 'activation', droppedStanding: true, previousDefaultVaultId: 'vlt_w' },
      }),
    );
    expect(full.note).toBe('during pairing; previously linked to claude@studio; its own standing approval was removed; its own default vault was reset');
  });

  it('unlinked manually and because the main device was revoked', () => {
    expect(linkText(row({ event: 'device.unlinked', deviceId: 'dev_cli', meta: { mainDeviceId: 'dev_1', cause: 'manual' } })).sentence).toBe('You unlinked asm@mbp from claude@mbp-office');
    const sys = linkText(row({ event: 'device.unlinked', actorType: 'system', actorId: null, deviceId: 'dev_cli', meta: { mainDeviceId: 'dev_1', cause: 'main_revoked' } }));
    expect(sys.sentence).toBe('asm@mbp is no longer linked to claude@mbp-office');
    expect(sys.note).toBe('main device revoked');
  });

  it('revocation, standing approval and default vault caused by linking', () => {
    const rev = linkText(row({ event: 'device.revoked', deviceId: 'dev_cli', meta: { cause: 'main_revoked' } }));
    expect(rev.sentence).toBe('You revoked access for asm@mbp');
    expect(rev.note).toBe('main device revoked');
    const sa = linkText(row({ event: 'standing_approval.removed', deviceId: 'dev_cli', meta: { cause: 'device_linked' } }));
    expect(sa.sentence).toBe('The standing approval for asm@mbp was removed');
    expect(sa.note).toBe('linked to a main device');
    const dv = linkText(row({ event: 'device.default_vault_changed', deviceId: 'dev_cli', vaultId: null, meta: { cause: 'device_linked', previousVaultId: 'vlt_w', vaultId: null } }));
    expect(dv.sentence).toBe('asm@mbp no longer has its own default vault');
    expect(dv.note).toBe('linked to a main device');
    expect(AUDIT_EVENTS).toContain('device.linked');
    expect(AUDIT_EVENTS).toContain('device.unlinked');
  });
});

describe('describeAudit: standing access proposed by an agent', () => {
  const proposal = { scope: 'list', vaultIds: [], secretIds: ['sec_1', 'sec_2'], days: 7, afterExpiry: 'renew', renewDays: 7 };
  const dev = { actorType: 'device' as const, actorId: 'dev_1' };

  it('created', () => {
    const r = text(row({ event: 'standing_request.created', ...dev, project: 'asm', meta: { requestId: 'srq_1', ...proposal } }));
    expect(r.sentence).toBe('claude@mbp-office asked for standing access to 2 secrets for 7 days for asm');
    expect(r.tone).toBe('amber');
    const vaults = text(row({ event: 'standing_request.created', ...dev, meta: { proposal: { ...proposal, scope: 'vaults', vaultIds: ['vlt_w'], secretIds: [], days: 1 } } }));
    expect(vaults.sentence).toBe('claude@mbp-office asked for standing access to 1 vault for 1 day');
  });

  it('approved as proposed, adjusted and via push', () => {
    const plain = text(row({ event: 'standing_request.approved', meta: { requestId: 'srq_1', final: proposal, diff: {}, adjusted: false, via: 'web' } }));
    expect(plain.sentence).toBe('You approved standing access for claude@mbp-office to 2 secrets for 7 days');
    expect(plain.note).toBeUndefined();
    expect(plain.tone).toBe('ok');
    const final = { ...proposal, secretIds: ['sec_1'], days: 3, afterExpiry: 'ask', renewDays: null };
    const diff = { days: { from: 7, to: 3 }, removedSecretIds: ['sec_2'], afterExpiry: { from: 'renew', to: 'ask' } };
    const adj = text(row({ event: 'standing_request.approved', meta: { final, diff, adjusted: true, via: 'push' } }));
    expect(adj.sentence).toBe('You approved standing access for claude@mbp-office to 1 secret for 3 days');
    expect(adj.note).toBe('adjusted: 1 secret removed, 3 days instead of 7, asks every time after expiry instead of extending; via push');
  });

  it('denied, expired and cancelled with cause', () => {
    const denied = text(row({ event: 'standing_request.denied', meta: { requestId: 'srq_1' } }));
    expect(denied.sentence).toBe('You denied standing access for claude@mbp-office');
    expect(denied.tone).toBe('danger');
    const sys = { actorType: 'system' as const, actorId: null };
    expect(text(row({ event: 'standing_request.expired', ...sys, meta: {} })).sentence).toBe('The request for standing access from claude@mbp-office expired');
    const cancelled = (cause: string) => text(row({ event: 'standing_request.cancelled', ...sys, meta: { cause } }));
    expect(cancelled('superseded').sentence).toBe('The request for standing access from claude@mbp-office was withdrawn');
    expect(cancelled('superseded').note).toBe('a standing approval was set by hand');
    expect(cancelled('device_revoked').note).toBe('device revoked');
    expect(cancelled('disabled_by_admin').note).toBe('standing approvals were turned off by the admin');
  });

  it('standing_approval.set notes the agent origin and whether you adjusted it', () => {
    const meta = { until: UNTIL, scope: 'list', secretCount: 2, allowUpdates: false, afterExpiry: 'ask', renewDays: 7, previous: null };
    const asIs = text(row({ event: 'standing_approval.set', meta: { ...meta, origin: { type: 'agent_request', requestId: 'srq_1', proposed: proposal, diff: {} } } }));
    expect(asIs.note).toBe('proposed by the agent; afterwards, every request asks again');
    const adj = text(
      row({ event: 'standing_approval.set', meta: { ...meta, origin: { type: 'agent_request', requestId: 'srq_1', proposed: proposal, diff: { days: { from: 7, to: 3 } } } } }),
    );
    expect(adj.note).toBe('proposed by the agent, adjusted by you; afterwards, every request asks again');
    expect(text(row({ event: 'standing_approval.set', meta })).note).toBe('afterwards, every request asks again');
  });

  it('lists the events in the filter', () => {
    for (const e of ['created', 'approved', 'denied', 'expired', 'cancelled']) {
      expect(AUDIT_EVENTS).toContain(`standing_request.${e}`);
      expect(isAutoEvent(`standing_request.${e}`)).toBe(true);
    }
  });
});
