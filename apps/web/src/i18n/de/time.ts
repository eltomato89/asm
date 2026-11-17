import type { Messages } from '../en';

export const time: Messages['time'] = {
  justNow: 'gerade eben',
  minutesAgo: (n) => `vor ${n} Min.`,
  hoursAgo: (n) => `vor ${n} Std.`,
  daysAgo: (n) => (n === 1 ? 'vor 1 Tag' : `vor ${n} Tagen`),
  today: 'Heute',
  yesterday: 'Gestern',
};
