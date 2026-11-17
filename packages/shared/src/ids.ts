import { ulid } from 'ulid';

export type IdPrefix = 'usr' | 'vlt' | 'sec' | 'dev' | 'req' | 'grt' | 'aud' | 'ses' | 'cli' | 'prj' | 'pky' | 'tok' | 'psh' | 'srq';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
