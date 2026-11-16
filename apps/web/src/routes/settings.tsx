import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { api, isApiError, queryKeys, type Passkey } from '../lib/api';
import { errorText } from '../lib/errors';
import { useTheme, type ThemeMode } from '../lib/theme';

const THEMES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Hell' },
  { mode: 'dark', label: 'Dunkel' },
];

export function SettingsPage() {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const { mode, setMode } = useTheme();
  return (
    <>
      <div className="page-head">
        <h1>Einstellungen</h1>
        {me.data ? (
          <span className="meta">
            angemeldet als <span className="mono">{me.data.username}</span>
          </span>
        ) : null}
      </div>

      <section className="settings-sec" aria-labelledby="s-theme">
        <div className="settings-text">
          <h2 id="s-theme">Darstellung</h2>
          <p>Gilt für diesen Browser.</p>
        </div>
        <div className="seg" role="group" aria-label="Darstellung">
          {THEMES.map((t) => (
            <button key={t.mode} type="button" aria-pressed={mode === t.mode} onClick={() => setMode(t.mode)}>
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <PasskeySection />

      {me.data?.isAdmin ? <AdminUsers /> : null}
    </>
  );
}

function passkeyError(e: unknown): string {
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Passkey-Registrierung abgebrochen.';
  if ((e instanceof Error && e.name === 'InvalidStateError') || isApiError(e, 'credential_exists')) return 'Dieser Passkey ist bereits registriert.';
  if (isApiError(e, 'last_credential')) return 'Das ist dein einziger Anmeldeweg. Lege zuerst einen weiteren Passkey an.';
  return errorText(e, 'Passkey-Aktion fehlgeschlagen.');
}

function PasskeySection() {
  const qc = useQueryClient();
  const toast = useToast();
  const passkeys = useQuery({ queryKey: queryKeys.passkeys, queryFn: api.passkeys });
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const supported = browserSupportsWebAuthn();

  const add = useMutation({
    mutationFn: async () => {
      const optionsJSON = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON });
      return api.passkeyRegisterVerify(response, name.trim() || undefined);
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
    add.mutate();
  };

  return (
    <section className="settings-sec" aria-labelledby="s-passkeys">
      <div className="settings-text">
        <h2 id="s-passkeys">Passkeys</h2>
        <p>Zum Anmelden und zum Bestätigen sensibler Aktionen wie „Anzeigen“ oder „Freigeben“ einer Kopplung.</p>
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
              <li key={p.id}>
                <span className="pk-name">
                  <KeyRound className="icon icon-sm faint" strokeWidth={1.5} aria-hidden />
                  {p.name}
                </span>
                <span className="faint">
                  hinzugefügt <RelativeTime ts={p.createdAt} />
                </span>
                <IconButton label={`Passkey ${p.name} entfernen`} className="icon-btn-sm" onClick={() => setRemoving(p)}>
                  <Trash2 className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                </IconButton>
              </li>
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
        <p className="help">Passwort ändern ist in dieser Version noch nicht möglich.</p>
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

function userError(e: unknown): string {
  if (isApiError(e, 'username_taken')) return 'Diesen Benutzernamen gibt es schon.';
  if (isApiError(e, 'invalid_username') || isApiError(e, 'invalid_request')) return 'Benutzername: 3–64 Zeichen aus Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich. Passwort: mindestens 12 Zeichen.';
  if (isApiError(e, 'invalid_password')) return 'Das Passwort braucht mindestens 12 Zeichen.';
  return errorText(e, 'Konto konnte nicht angelegt werden.');
}

const USERNAME_RE = /^[a-z0-9._-]{3,64}$/i;

function AdminUsers() {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createUser({ username: username.trim(), password, isAdmin }),
    onSuccess: (u) => {
      toast(`Konto ${u.username} angelegt.`, 'ok');
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setError(null);
    },
    onError: (e) => setError(userError(e)),
  });
  const valid = USERNAME_RE.test(username.trim()) && password.length >= 12;
  return (
    <section className="settings-sec" aria-labelledby="s-users">
      <div className="settings-text">
        <h2 id="s-users">Nutzerverwaltung</h2>
        <p>Neue Konten erhalten einen eigenen persönlichen Tresor. Teile Secrets über gemeinsame Tresore.</p>
      </div>
      <form
        className="settings-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
        aria-label="Konto anlegen"
      >
        <Input label="Benutzername" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        <Input
          label="Startpasswort"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          help="Mindestens 12 Zeichen. Gib es sicher weiter; die Person kann danach einen Passkey hinzufügen."
        />
        <label className="check">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Administrator
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
            Konto anlegen
          </Button>
        </div>
      </form>
    </section>
  );
}
