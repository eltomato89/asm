import { describe, expect, it } from 'vitest';
import { parseTags, validateSecretForm, type SecretFormValues } from './validation';

const base: SecretFormValues = {
  title: 'GitHub',
  description: '',
  tags: '',
  envName: '',
  allowPlaintextToAgent: false,
  valueMode: 'enter',
  value: 'x',
  length: 32,
  alphabet: 'alnum',
};

describe('validateSecretForm', () => {
  it('accepts a minimal valid secret', () => {
    expect(validateSecretForm(base, { creating: true })).toEqual({});
  });

  it('mirrors the server rules', () => {
    const e = validateSecretForm(
      { ...base, title: ' ', description: 'x'.repeat(4001), tags: 'ok bad/tag', envName: '1ABC', value: 'x'.repeat(64 * 1024 + 1) },
      { creating: true },
    );
    expect(Object.keys(e).sort()).toEqual(['description', 'envName', 'tags', 'title', 'value']);
    expect(e.title).toBe('Enter a title.');
    expect(e.description).toBe('At most 4000 characters.');
    expect(validateSecretForm({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(' ') }, { creating: true }).tags).toBeTruthy();
    expect(validateSecretForm({ ...base, tags: 'a'.repeat(41) }, { creating: true }).tags).toBeTruthy();
    expect(validateSecretForm({ ...base, envName: 'GITHUB_TOKEN', tags: 'prod-eu ci.deploy Ümlaut' }, { creating: true })).toEqual({});
  });

  it('requires a value when creating, not when editing with "keep"', () => {
    expect(validateSecretForm({ ...base, valueMode: 'keep', value: '' }, { creating: true }).value).toBeTruthy();
    expect(validateSecretForm({ ...base, valueMode: 'keep', value: '' }, { creating: false }).value).toBeUndefined();
  });

  it('checks the generator length 16–256', () => {
    expect(validateSecretForm({ ...base, valueMode: 'generate', length: 15 }, { creating: true }).length).toBeTruthy();
    expect(validateSecretForm({ ...base, valueMode: 'generate', length: 257 }, { creating: true }).length).toBeTruthy();
    expect(validateSecretForm({ ...base, valueMode: 'generate', length: 16 }, { creating: true })).toEqual({});
  });

  it('parses tags separated by commas and spaces', () => {
    expect(parseTags(' ci, deploy  prod ')).toEqual(['ci', 'deploy', 'prod']);
  });
});
