// Client-side mirror of the server's secret rules (packages/shared/src/schemas.ts). Kept zod-free so the
// bundle stays small; the server validates again and remains authoritative.

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
    .map((t) => t.trim())
    .filter(Boolean);

export function validateSecretForm(v: SecretFormValues, opts: { creating: boolean }): SecretFormErrors {
  const e: SecretFormErrors = {};
  const title = v.title.trim();
  if (!title) e.title = 'Gib einen Titel ein.';
  else if (title.length > 200) e.title = 'Höchstens 200 Zeichen.';
  if (v.description.length > 4000) e.description = 'Höchstens 4000 Zeichen.';
  const tags = parseTags(v.tags);
  if (tags.length > 20) e.tags = 'Höchstens 20 Tags.';
  else if (tags.some((t) => t.length > 40)) e.tags = 'Ein Tag darf höchstens 40 Zeichen lang sein.';
  else if (tags.some((t) => !TAG_RE.test(t))) e.tags = 'Tags bestehen aus Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich.';
  const env = v.envName.trim();
  if (env && (env.length > 200 || !ENV_NAME_RE.test(env))) e.envName = 'Großbuchstaben, Ziffern und Unterstrich, nicht mit einer Ziffer beginnend (z. B. GITHUB_TOKEN).';
  if (v.valueMode === 'enter' || (opts.creating && v.valueMode === 'keep')) {
    if (!v.value) e.value = 'Gib einen Wert ein oder lass ihn generieren.';
    else if (new TextEncoder().encode(v.value).length > MAX_VALUE_BYTES) e.value = 'Der Wert darf höchstens 64 KiB groß sein.';
  }
  if (v.valueMode === 'generate' && (!Number.isInteger(v.length) || v.length < 16 || v.length > 256)) e.length = 'Länge zwischen 16 und 256.';
  return e;
}
