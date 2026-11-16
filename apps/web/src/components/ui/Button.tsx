import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'md' | 'lg'; block?: boolean };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'default', size = 'md', block, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'lg' && 'btn-lg',
        block && 'btn-block',
        className,
      )}
      {...rest}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton(
  { label, className, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={cx('icon-btn', className)} aria-label={label} title={label} {...rest} />;
});
