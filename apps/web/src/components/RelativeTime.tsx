import { formatAbsolute, formatRelative } from '../lib/format';
import { useNow } from '../lib/time';

/** "3 min ago" with the absolute time as title; refreshes every 30 s. */
export function RelativeTime({ ts, className }: { ts: number; className?: string }) {
  const now = useNow(30_000);
  return (
    <time className={className ? `${className} num` : 'num'} dateTime={new Date(ts).toISOString()} title={formatAbsolute(ts)}>
      {formatRelative(ts, now)}
    </time>
  );
}
