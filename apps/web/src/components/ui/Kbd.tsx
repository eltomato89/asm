import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx('kbd', className)} {...rest} />;
}

/** "⌘K" on Apple platforms, "Strg K" elsewhere. */
export function modKeyLabel(key: string): string {
  const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return apple ? `⌘${key}` : `Strg ${key}`;
}
