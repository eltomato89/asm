// German date/time formatting: relative times with an absolute title, day headings for grouped lists.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const absFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTimeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

/** "16.11.2026, 14:02:11" — for title attributes and detail views. */
export const formatAbsolute = (ts: number): string => absFmt.format(ts);
/** "14:02:11" */
export const formatTime = (ts: number): string => timeFmt.format(ts);
/** "14:02" */
export const formatShortTime = (ts: number): string => shortTimeFmt.format(ts);
/** "16. Nov. 2026" */
export const formatDay = (ts: number): string => dayFmt.format(ts);

/** "gerade eben", "vor 3 Min.", "vor 2 Std.", "vor 4 Tagen", then the date. */
export function formatRelative(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'gerade eben';
  if (d < HOUR) return `vor ${Math.floor(d / MIN)} Min.`;
  if (d < DAY) return `vor ${Math.floor(d / HOUR)} Std.`;
  const days = Math.floor(d / DAY);
  if (days === 1) return 'vor 1 Tag';
  if (days < 30) return `vor ${days} Tagen`;
  return formatDay(ts);
}

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Key + label for grouping rows by local calendar day: "Heute", "Gestern" or the weekday-less date. */
export function dayGroup(ts: number, now = Date.now()): { key: number; label: string; date: string } {
  const key = startOfDay(ts);
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const label = key === today ? 'Heute' : key === yesterday ? 'Gestern' : formatDay(ts);
  return { key, label, date: formatDay(ts) };
}

/** "1.284" */
export const formatCount = (n: number): string => n.toLocaleString('de-DE');
