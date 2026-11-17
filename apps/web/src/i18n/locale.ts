// Locale detection and persistence. English is the default; German is bundled.

export type Locale = 'en' | 'de';
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
];
export const LOCALE_KEY = 'asm-locale';

const isLocale = (v: unknown): v is Locale => v === 'en' || v === 'de';

/** Explicit choice from this browser, or null when following the browser language. */
export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** Stored choice, else the first supported browser language, else English. */
export function detectLocale(): Locale {
  const stored = storedLocale();
  if (stored) return stored;
  const langs = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const l of langs) {
    const base = l?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

/** Persists the choice (null = follow the browser). */
export function storeLocale(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(LOCALE_KEY, locale);
    else localStorage.removeItem(LOCALE_KEY);
  } catch {
    // storage unavailable: choice lasts for this page only
  }
}
