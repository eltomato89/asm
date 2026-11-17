import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Trash } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, isApiError, queryKeys, type Passkey } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { RelativeTime } from '../RelativeTime';
import { Button, IconButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';

function passkeyError(e: unknown): string {
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Passkey-Registrierung abgebrochen.';
  if ((e instanceof Error && e.name === 'InvalidStateError') || isApiError(e, 'credential_exists')) return 'Dieser Passkey ist bereits registriert.';
  if (isApiError(e, 'last_credential')) return 'Das ist dein einziger Anmeldeweg. Lege zuerst einen weiteren Passkey an.';
  return errorText(e, 'Passkey-Aktion fehlgeschlagen.');
}

export function PasskeySection() {
  const qc = useQueryClient();
  const toast = useToast();
  const passkeys = useQuery({ queryKey: queryKeys.passkeys, queryFn: api.passkeys });
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const supported = browserSupportsWebAuthn();

  const add = useMutation({
    mutationFn: async (label: string) => {
      const optionsJSON = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON });
      return api.passkeyRegisterVerify(response, label || undefined);
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: queryKeys.passkeys });
      toast(`Passkey „${p.name}“ hinzugefügt.`, 'ok');
      setName('');
    },
    onError: (e) => toast(passkeyError(e), 'danger'),
  });
  const remove = useMutation({
    mutationFn: (p: Passkey) => api.deletePasskey(p.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.passkeys });
      toast('Passkey entfernt.', 'ok');
      setRemoving(null);
    },
    onError: (e) => {
      setRemoving(null);
      toast(passkeyError(e), 'danger');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(name.trim());
  };

  return (
    <section className="settings-sec" aria-labelledby="s-passkeys">
      <div className="settings-text">
        <h2 id="s-passkeys">Passkeys</h2>
        <p>Zum Anmelden und zum Bestätigen sensibler Aktionen wie „Anzeigen“ oder dem Freigeben einer Kopplung.</p>
      </div>
      <div className="settings-body">
        {passkeys.isPending ? (
          <Skeleton width="100%" height={40} />
        ) : passkeys.isError ? (
          <p className="faint">Passkeys konnten nicht geladen werden.</p>
        ) : passkeys.data.length === 0 ? (
          <p className="faint">Noch kein Passkey. Du meldest dich mit Passwort an.</p>
        ) : (
          <ul className="mini-list" aria-label="Passkeys">
            {passkeys.data.map((p) => (
              <PasskeyItem key={p.id} passkey={p} onRemove={() => setRemoving(p)} />
            ))}
          </ul>
        )}
        <form className="inline-form" onSubmit={submit}>
          <Input label="Name des neuen Passkeys" placeholder="MacBook Touch ID" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={!supported || add.isPending}>
            Passkey hinzufügen
          </Button>
        </form>
        {!supported ? <p className="help">Dieser Browser unterstützt keine Passkeys.</p> : null}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Passkey „${removing?.name ?? ''}“ entfernen?`}
        description="Mit diesem Passkey kannst du dich danach nicht mehr anmelden."
        confirmLabel="Entfernen"
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </section>
  );
}

function PasskeyItem({ passkey: p, onRemove }: { passkey: Passkey; onRemove: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const rename = useMutation({
    mutationFn: (n: string) => api.renamePasskey(p.id, n),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.passkeys });
      setEditing(false);
      toast('Passkey umbenannt.', 'ok');
    },
    onError: (e) => toast(errorText(e, 'Umbenennen fehlgeschlagen.'), 'danger'),
  });
  const save = () => {
    const n = name.trim();
    if (!n || n === p.name) return setEditing(false);
    rename.mutate(n);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      setName(p.name);
      setEditing(false);
    }
  };
  return (
    <li>
      {editing ? (
        <input className="inline-input" aria-label="Name des Passkeys" autoFocus maxLength={100} value={name} disabled={rename.isPending} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} onBlur={save} />
      ) : (
        <span className="pk-name">
          <KeyRound className="icon icon-sm faint" strokeWidth={1.5} aria-hidden />
          {p.name}
        </span>
      )}
      <span className="faint">
        hinzugefügt <RelativeTime ts={p.createdAt} />
      </span>
      <IconButton
        label={`Passkey ${p.name} umbenennen`}
        className="icon-btn-sm"
        onClick={() => {
          setName(p.name);
          setEditing(true);
        }}
      >
        <Pencil className="icon icon-sm" strokeWidth={1.5} aria-hidden />
      </IconButton>
      <IconButton label={`Passkey ${p.name} entfernen`} className="icon-btn-sm" onClick={onRemove}>
        <Trash className="icon icon-sm" strokeWidth={1.5} aria-hidden />
      </IconButton>
    </li>
  );
}
