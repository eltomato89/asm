import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
};

/** Modal dialog: hairline panel with the overlay shadow, scrim behind (no blur). */
export function Dialog({ open, onOpenChange, title, description, children, actions }: Props) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content className="dialog" {...(description ? {} : { 'aria-describedby': undefined })}>
          <div className="dialog-head">
            <RadixDialog.Title>{title}</RadixDialog.Title>
            {description ? <RadixDialog.Description>{description}</RadixDialog.Description> : null}
          </div>
          {children ? <div className="dialog-body">{children}</div> : null}
          {actions ? <div className="dialog-actions">{actions}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
