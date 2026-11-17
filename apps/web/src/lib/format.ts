// Locale-aware date/time formatting: relative times with an absolute title, day headings for grouped lists.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

import { intlLocale, t } from '../i18n';

// Formatters are cached per locale so tests (and a future live switch) pick up setLocale.
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(name: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${intlLocale}|${name}`;
  let f = cache.get(key);
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(intlLocale, opts)));
  return f;
}
const absFmt = () => fmt('abs', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const timeFmt = () => fmt('time', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTimeFmt = () => fmt('short', { hour: '2-digit', minute: '2-digit' });
const dayFmt = () => fmt('day', { day: 'numeric', month: 'short', year: 'numeric' });

/** e.g. "11/16/2026, 02:02:11 PM" / "16.11.2026, 14:02:11" — for title attributes and detail views. */
export const formatAbsolute = (ts: number): string => absFmt().format(ts);
/** "14:02:11" */
export const formatTime = (ts: number): string => timeFmt().format(ts);
/** "14:02" */
export const formatShortTime = (ts: number): string => shortTimeFmt().format(ts);
/** "Nov 16, 2026" / "16. Nov. 2026" */
export const formatDay = (ts: number): string => dayFmt().format(ts);

/** "just now", "3 min ago", "2 h ago", "4 days ago", then the date. */
export function formatRelative(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return t.time.justNow;
  if (d < HOUR) return t.time.minutesAgo(Math.floor(d / MIN));
  if (d < DAY) return t.time.hoursAgo(Math.floor(d / HOUR));
  const days = Math.floor(d / DAY);
  if (days < 30) return t.time.daysAgo(days);
  return formatDay(ts);
}

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Key + label for grouping rows by local calendar day: "Today", "Yesterday" or the weekday-less date. */
export function dayGroup(ts: number, now = Date.now()): { key: number; label: string; date: string } {
  const key = startOfDay(ts);
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const label = key === today ? t.time.today : key === yesterday ? t.time.yesterday : formatDay(ts);
  return { key, label, date: formatDay(ts) };
}

/** "1,284" / "1.284" */
export const formatCount = (n: number): string => n.toLocaleString(intlLocale);
