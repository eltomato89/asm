import { describe, expect, it } from 'vitest';
import { StandingApprovalInputSchema } from '../src/schemas.js';

describe('StandingApprovalInputSchema', () => {
  it('applies defaults', () => {
    expect(StandingApprovalInputSchema.parse({ until: 1, scope: 'all' })).toEqual({
      until: 1, scope: 'all', secretIds: [], vaultIds: [], includeCreated: false, allowUpdates: false, afterExpiry: 'ask', renewDays: 7,
    });
  });
  it('rejects an empty list scope with empty_list', () => {
    const r = StandingApprovalInputSchema.safeParse({ until: 1, scope: 'list' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('empty_list');
  });
  it('accepts a list scope with includeCreated only or with secrets', () => {
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'list', includeCreated: true }).success).toBe(true);
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'list', secretIds: ['sec_1'] }).success).toBe(true);
  });
  it('rejects renewDays < 1, unknown keys and more than 200 secrets', () => {
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'all', renewDays: 0 }).success).toBe(false);
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'all', extra: 1 }).success).toBe(false);
    const ids = Array.from({ length: 201 }, (_, i) => `sec_${i}`);
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'list', secretIds: ids }).success).toBe(false);
  });
  it('rejects a vaults scope without vaults with empty_vaults', () => {
    const r = StandingApprovalInputSchema.safeParse({ until: 1, scope: 'vaults' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toEqual(['empty_vaults']);
    // includeCreated does not satisfy the vaults scope
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'vaults', includeCreated: true }).success).toBe(false);
  });
  it('accepts a vaults scope with vault ids (no secrets needed) and caps vaultIds at 50', () => {
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'vaults', vaultIds: ['vlt_1'] }).success).toBe(true);
    const ids = Array.from({ length: 51 }, (_, i) => `vlt_${i}`);
    expect(StandingApprovalInputSchema.safeParse({ until: 1, scope: 'vaults', vaultIds: ids }).success).toBe(false);
  });
});
