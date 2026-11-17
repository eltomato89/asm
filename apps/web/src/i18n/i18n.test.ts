import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';

// Every English key must exist in German with the same kind (string vs. function); TS checks shape,
// this guards against accidental `undefined`/empty strings slipping in via casts.
function walk(a: Record<string, unknown>, b: Record<string, unknown>, path: string[] = []): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    const w = b[k];
    const p = [...path, k].join('.');
    if (typeof v === 'object' && v) problems.push(...walk(v as Record<string, unknown>, (w ?? {}) as Record<string, unknown>, [...path, k]));
    else if (typeof w !== typeof v || w === '') problems.push(p);
  }
  return problems;
}

describe('dictionaries', () => {
  it('German covers every English key', () => {
    expect(walk(en, de)).toEqual([]);
  });
});
