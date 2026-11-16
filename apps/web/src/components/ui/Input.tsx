import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  help?: ReactNode;
  icon?: ReactNode;
  /** Monospace value (tokens, ENV names); default for technical inputs. */
  mono?: boolean;
};

/** Labelled text field in the mockup style (hairline box, label above, optional help line). */
export const Input = forwardRef<HTMLInputElement, Props>(function Input({ label, help, icon, mono = false, id, className, ...rest }, ref) {
  const auto = useId();
  const inputId = id ?? auto;
  const helpId = help ? `${inputId}-help` : undefined;
  return (
    <div className={cx('field', className)}>
      <label htmlFor={inputId}>{label}</label>
      <div className={cx('input', !mono && 'input-plain')}>
        {icon}
        <input ref={ref} id={inputId} aria-describedby={helpId} {...rest} />
      </div>
      {help ? (
        <p className="help" id={helpId}>
          {help}
        </p>
      ) : null}
    </div>
  );
});
