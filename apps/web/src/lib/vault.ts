import type { VaultDto } from '@asm/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { t } from '../i18n';

const KEY = 'asm-vault';
const subscribers = new Set<() => void>();
let memory: string | null = null;

function read(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Display name of a vault: the personal vault gets a localized label instead of its stored name. */
export function vaultLabel(v: Pick<VaultDto, 'name' | 'personal'>): string {
  return v.personal ? t.vaults.personal : v.name;
}

/** Currently selected vault (sidebar switcher), persisted per browser; defaults to the personal vault. */
export function useCurrentVault(vaults: VaultDto[] | undefined): { vault: VaultDto | undefined; select: (id: string) => void } {
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const vault = vaults?.find((v) => v.id === stored) ?? vaults?.find((v) => v.personal) ?? vaults?.[0];
  const select = useCallback((id: string) => {
    memory = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // storage unavailable: selection lasts for this page only
    }
    subscribers.forEach((fn) => fn());
  }, []);
  return { vault, select };
}
