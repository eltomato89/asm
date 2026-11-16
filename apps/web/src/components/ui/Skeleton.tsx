import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';

/** Loading placeholder (used instead of spinners). */
export function Skeleton({ width, height = 12, className, style }: { width?: CSSProperties['width']; height?: CSSProperties['height']; className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={cx('skeleton', className)} style={{ width, height, ...style }} />;
}
