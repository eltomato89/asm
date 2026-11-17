import type { HTMLAttributes } from 'react';
import { t } from '../../i18n';
import { cx } from '../../lib/cx';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx('kbd', className)} {...rest} />;
}

/** "⌘K" on Apple platforms, "Ctrl K" (localized modifier name) elsewhere. */
export function modKeyLabel(key: string): string {
  const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return apple ? `⌘${key}` : `${t.layout.ctrlKey} ${key}`;
}
