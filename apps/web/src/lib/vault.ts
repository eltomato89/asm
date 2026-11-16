import type { VaultDto } from '@asm/shared';
import { useCallback, useSyncExternalStore } from 'react';

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
