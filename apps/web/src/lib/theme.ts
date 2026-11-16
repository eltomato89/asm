import { useEffect, useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export const THEME_KEY = 'asm-theme';

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((fn) => fn());

function read(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function getThemeMode(): ThemeMode {
  const v = read();
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** Applies the mode as data-theme on <html> (system = no attribute) and persists it. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch {
    // storage unavailable (private mode): theme still applies for this page
  }
  notify();
}

const darkQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** The theme actually shown (resolves 'system' via prefers-color-scheme). */
export function effectiveTheme(mode = getThemeMode()): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return darkQuery()?.matches ? 'dark' : 'light';
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  const mq = darkQuery();
  mq?.addEventListener?.('change', fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    const v = e.newValue;
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
    else document.documentElement.removeAttribute('data-theme');
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(fn);
    mq?.removeEventListener?.('change', fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTheme(): { mode: ThemeMode; effective: 'light' | 'dark'; setMode: (m: ThemeMode) => void } {
  const mode = useSyncExternalStore(subscribe, getThemeMode, () => 'system' as ThemeMode);
  const effective = useSyncExternalStore(subscribe, () => effectiveTheme(mode), () => 'light' as const);
  useEffect(() => {
    // keep <html> in sync if the attribute was set before hydration
    if (mode !== 'system' && document.documentElement.getAttribute('data-theme') !== mode) applyTheme(mode);
  }, [mode]);
  return { mode, effective, setMode: applyTheme };
}
