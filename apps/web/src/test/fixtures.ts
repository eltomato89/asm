import type { AccessRequestDto, DeviceDto, SecretMeta, StandingApprovalSummary, VaultDto } from '@asm/shared';

export const T0 = Date.UTC(2026, 10, 16, 14, 0, 0);

export function makeRequest(over: Partial<AccessRequestDto> = {}): AccessRequestDto {
  return {
    id: 'req_01',
    kind: 'read',
    status: 'pending',
    secret: { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultId: 'vlt_p', vaultName: 'Personal' },
    device: { id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp' },
    project: 'agent-secrets-manager',
    reason: 'Push the release workflow',
    delivery: 'cli',
    auto: false,
    autoSource: null,
    renewal: null,
    decidedBy: null,
    createdAt: T0,
    decidedAt: null,
    expiresAt: T0 + 300_000,
    ...over,
  };
}

export function makeDevice(over: Partial<DeviceDto> = {}): DeviceDto {
  return {
    id: 'dev_1',
    name: 'claude@mbp-office',
    kind: 'mcp',
    hostname: 'mbp-office',
    status: 'approved',
    lastUsedAt: T0 - 60_000,
    createdAt: T0 - 86_400_000,
    standingApproval: null,
    ...over,
  };
}

/** Active standing approval summary, 7 days from T0, all secrets. */
export function makeStandingSummary(over: Partial<StandingApprovalSummary> = {}): StandingApprovalSummary {
  return {
    until: T0 + 7 * 86_400_000,
    active: true,
    scope: 'all',
    secretCount: 0,
    allowUpdates: false,
    afterExpiry: 'ask',
    renewDays: 7,
    ...over,
  };
}

export function makeSecret(over: Partial<SecretMeta> = {}): SecretMeta {
  return {
    id: 'sec_1',
    vaultId: 'vlt_p',
    vaultName: 'Personal',
    title: 'GitHub',
    description: 'Token for releases',
    tags: ['ci'],
    envName: 'GITHUB_TOKEN',
    allowPlaintextToAgent: false,
    updatedAt: T0,
    createdBy: { type: 'user', id: 'usr_1', name: 'jana' },
    archived: null,
    ...over,
  };
}

export const ME = { id: 'usr_1', username: 'jana', isAdmin: true };

export const VAULTS: { items: VaultDto[] } = {
  items: [
    { id: 'vlt_p', name: 'Personal', personal: true, role: 'owner', members: [{ userId: 'usr_1', username: 'jana', role: 'owner' }], createdAt: 0 },
    { id: 'vlt_w', name: 'Work', personal: false, role: 'owner', members: [{ userId: 'usr_1', username: 'jana', role: 'owner' }, { userId: 'usr_2', username: 'tom', role: 'member' }], createdAt: 0 },
  ],
};
