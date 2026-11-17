import type { AccessRequestDto, DeviceDto, SecretMeta, StandingApprovalSummary, StandingRequestDto, VaultDto } from '@asm/shared';

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
    defaultVault: { id: 'vlt_p', name: 'Personal', personal: true },
    linkedTo: null,
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
    vaultCount: 0,
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

/** Pending proposal of a standing approval: 2 secrets for 7 days, then renew by 7 days; 30 minutes to decide. */
export function makeStandingRequest(over: Partial<StandingRequestDto> = {}): StandingRequestDto {
  return {
    id: 'srq_01',
    status: 'pending',
    device: { id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp' },
    attachedCli: [],
    project: 'agent-secrets-manager',
    reason: 'Runs the test suite against staging several times a day',
    proposal: { scope: 'list', vaultIds: [], secretIds: ['sec_1', 'sec_2'], days: 7, afterExpiry: 'renew', renewDays: 7 },
    items: {
      vaults: [],
      secrets: [
        { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultName: 'Personal', available: true },
        { id: 'sec_2', title: 'OpenAI', envName: 'OPENAI_API_KEY', vaultName: 'Work', available: true },
      ],
    },
    limits: { maxDays: 14 },
    final: null,
    adjusted: false,
    cause: null,
    decidedBy: null,
    createdAt: Date.now(),
    decidedAt: null,
    expiresAt: Date.now() + 30 * 60_000,
    ...over,
  };
}
