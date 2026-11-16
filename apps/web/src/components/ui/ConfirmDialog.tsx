import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
};

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, danger, typeToConfirm, busy, onConfirm, children }: Props) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const ok = typeToConfirm === undefined || typed.trim() === typeToConfirm;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok || busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {typeToConfirm !== undefined ? (
        <Input
          label={`Zum Bestätigen „${typeToConfirm}“ eingeben`}
          mono
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      ) : null}
    </Dialog>
  );
}
