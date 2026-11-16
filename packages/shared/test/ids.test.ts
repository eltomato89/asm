import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';

describe('newId', () => {
  it('produces prefix + 26 char Crockford ULID', () => {
    expect(newId('sec')).toMatch(/^sec_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it('is unique', () => {
    expect(newId('usr')).not.toBe(newId('usr'));
  });
});
