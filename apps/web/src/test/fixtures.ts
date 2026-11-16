import type { AccessRequestDto, SecretMeta, VaultDto } from '@asm/shared';

export const T0 = Date.UTC(2026, 10, 16, 14, 0, 0);

export function makeRequest(over: Partial<AccessRequestDto> = {}): AccessRequestDto {
  return {
    id: 'req_01',
    kind: 'read',
    status: 'pending',
    secret: { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultId: 'vlt_p', vaultName: 'Persönlich' },
    device: { id: 'dev_1', name: 'claude@mbp-office', kind: 'mcp' },
    project: 'agent-secrets-manager',
    reason: 'Release-Workflow pushen',
    delivery: 'cli',
    auto: false,
    decidedBy: null,
    createdAt: T0,
    decidedAt: null,
    expiresAt: T0 + 300_000,
    ...over,
  };
}

export function makeSecret(over: Partial<SecretMeta> = {}): SecretMeta {
  return {
    id: 'sec_1',
    vaultId: 'vlt_p',
    vaultName: 'Persönlich',
    title: 'GitHub',
    description: 'Token für Releases',
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
    { id: 'vlt_p', name: 'Persönlich', personal: true, role: 'owner', members: [{ userId: 'usr_1', username: 'jana', role: 'owner' }], createdAt: 0 },
    { id: 'vlt_w', name: 'Arbeit', personal: false, role: 'owner', members: [{ userId: 'usr_1', username: 'jana', role: 'owner' }, { userId: 'usr_2', username: 'tom', role: 'member' }], createdAt: 0 },
  ],
};
