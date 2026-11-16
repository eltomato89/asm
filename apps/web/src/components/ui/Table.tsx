import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

/** Dense data table: hairline frame, 34 px header on --bg, 40 px rows. */
export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cx('data-table', className)} {...rest} />;
}
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />;
export const Tr = (p: HTMLAttributes<HTMLTableRowElement>) => <tr {...p} />;
export const Th = ({ scope = 'col', ...p }: ThHTMLAttributes<HTMLTableCellElement>) => <th scope={scope} {...p} />;
export const Td = (p: TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} />;
