export const time = {
  justNow: 'just now',
  minutesAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  daysAgo: (n: number) => (n === 1 ? '1 day ago' : `${n} days ago`),
  today: 'Today',
  yesterday: 'Yesterday',
};
