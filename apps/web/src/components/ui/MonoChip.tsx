import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

/**
 * Technical identifiers in mono: `chip` for event codes / IDs, `secret` for ENV names in running text,
 * `host` for device/host names.
 */
export function MonoChip({ variant = 'chip', tone, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { variant?: 'chip' | 'secret' | 'host'; tone?: 'amber' }) {
  return <span className={cx(variant, tone === 'amber' && 'chip-amber', className)} {...rest} />;
}
