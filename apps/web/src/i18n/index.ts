// UI strings. `t` is a live binding to the active dictionary: read it at render/call time,
// never copy values into module-level constants (they would not follow setLocale in tests).
//
// Usage: t.secrets.title, t.autoMode.activeFor(15). The English dictionary in ./en is the
// source of truth; ./de must have the same shape (enforced by the Messages type).

import { de } from './de';
import { en, type Messages } from './en';
import { detectLocale, storeLocale, type Locale } from './locale';

export type { Messages } from './en';
export { LOCALES, storedLocale, type Locale } from './locale';

const DICTS: Record<Locale, Messages> = { en, de };
const INTL: Record<Locale, string> = { en: 'en-US', de: 'de-DE' };

export let locale: Locale = detectLocale();
export let t: Messages = DICTS[locale];
/** BCP 47 tag for Intl formatters. */
export let intlLocale: string = INTL[locale];

/** Switches the active dictionary in place (tests, startup). Components already rendered keep their text. */
export function setLocale(next: Locale): void {
  locale = next;
  t = DICTS[next];
  intlLocale = INTL[next];
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/** User-facing language switch: persists the choice (null = browser language) and reloads the page. */
export function changeLocale(next: Locale | null): void {
  storeLocale(next);
  window.location.reload();
}

setLocale(locale);
