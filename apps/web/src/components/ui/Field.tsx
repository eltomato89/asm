import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

/** Inline validation message under a field. */
export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="field-error" id={id} role="alert">
      {children}
    </p>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; help?: ReactNode; error?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, help, error, id, className, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('field', className)}>
      <label htmlFor={fid}>{label}</label>
      <textarea ref={ref} id={fid} className="textarea" aria-invalid={error ? true : undefined} aria-describedby={error ? `${fid}-err` : help ? `${fid}-help` : undefined} {...rest} />
      {help && !error ? (
        <p className="help" id={`${fid}-help`}>
          {help}
        </p>
      ) : null}
      <FieldError id={`${fid}-err`}>{error}</FieldError>
    </div>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  help?: ReactNode;
  /** Compact variant for table cells: smaller select, label only for screen readers. */
  compact?: boolean;
};

export function Select({ label, help, id, className, compact, children, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('field', compact && 'field-compact', className)}>
      <label htmlFor={fid} className={compact ? 'visually-hidden' : undefined}>
        {label}
      </label>
      <select id={fid} className={cx('select', compact && 'select-sm')} {...rest}>
        {children}
      </select>
      {help ? <p className="help">{help}</p> : null}
    </div>
  );
}

/** On/off switch (checkbox semantics as role=switch). */
export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <label className="switch" htmlFor={fid}>
      <input id={fid} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-label">{label}</span>
    </label>
  );
}
