import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export type BadgeTone = 'neutral' | 'amber' | 'ok' | 'danger';

/** Small hairline label; tone only changes the text colour (no tinted fill). */
export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('badge', tone !== 'neutral' && `badge-${tone}`, className)} {...rest} />;
}

/** Sidebar counter (mono, amber), hidden at 0. */
export function CountBadge({ n, label }: { n: number; label?: string }) {
  if (n <= 0) return null;
  return (
    <span className="count num" data-n={n} aria-label={label}>
      {n}
    </span>
  );
}
