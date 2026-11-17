// Client-side mirror of the server's secret rules (packages/shared/src/schemas.ts). Kept zod-free so the
// bundle stays small; the server validates again and remains authoritative.

import { t } from '../i18n';

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const TAG_RE = /^[\p{L}\p{N}._-]+$/u;
export const MAX_VALUE_BYTES = 64 * 1024;
export const GENERATE_ALPHABETS = ['alnum', 'hex', 'base64url', 'symbols'] as const;
export type Alphabet = (typeof GENERATE_ALPHABETS)[number];

export type SecretFormValues = {
  title: string;
  description: string;
  tags: string;
  envName: string;
  allowPlaintextToAgent: boolean;
  valueMode: 'keep' | 'enter' | 'generate';
  value: string;
  length: number;
  alphabet: Alphabet;
};

export type SecretFormErrors = Partial<Record<'title' | 'description' | 'tags' | 'envName' | 'value' | 'length', string>>;

/** "ci, deploy  prod" → ["ci", "deploy", "prod"] */
export const parseTags = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function validateSecretForm(v: SecretFormValues, opts: { creating: boolean }): SecretFormErrors {
  const e: SecretFormErrors = {};
  const m = t.secrets.validation;
  const title = v.title.trim();
  if (!title) e.title = m.titleRequired;
  else if (title.length > 200) e.title = m.maxChars(200);
  if (v.description.length > 4000) e.description = m.maxChars(4000);
  const tags = parseTags(v.tags);
  if (tags.length > 20) e.tags = m.maxTags(20);
  else if (tags.some((tag) => tag.length > 40)) e.tags = m.tagTooLong(40);
  else if (tags.some((tag) => !TAG_RE.test(tag))) e.tags = m.tagChars;
  const env = v.envName.trim();
  if (env && (env.length > 200 || !ENV_NAME_RE.test(env))) e.envName = m.envName;
  if (v.valueMode === 'enter' || (opts.creating && v.valueMode === 'keep')) {
    if (!v.value) e.value = m.valueRequired;
    else if (new TextEncoder().encode(v.value).length > MAX_VALUE_BYTES) e.value = m.valueTooLarge;
  }
  if (v.valueMode === 'generate' && (!Number.isInteger(v.length) || v.length < 16 || v.length > 256)) e.length = m.lengthRange(16, 256);
  return e;
}
