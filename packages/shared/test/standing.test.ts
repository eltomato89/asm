import { describe, expect, it } from 'vitest';
import { StandingApprovalInputSchema } from '../src/schemas.js';

describe('StandingApprovalInputSchema', () => {
  it('applies defaults', () => {
    expect(StandingApprovalInputSchema.parse({ until: 1, scope: 'all' })).toEqual({
      until: 1, scope: 'all', secretIds: [], includeCreated: false, allowUpdates: false, afterExpiry: 'ask', renewDays: 7,
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
});
