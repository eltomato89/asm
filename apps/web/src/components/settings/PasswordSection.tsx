import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isApiError, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

const MIN = 12;

function passwordError(e: unknown): string {
  if (isApiError(e, 'invalid_credentials')) return 'Das aktuelle Passwort stimmt nicht.';
  if (isApiError(e, 'current_password_required')) return 'Gib dein aktuelles Passwort ein.';
  if (isApiError(e, 'invalid_request')) return `Das neue Passwort braucht mindestens ${MIN} Zeichen.`;
  return errorText(e, 'Passwort konnte nicht geändert werden.');
}

/**
 * Change (or first set) the own password. Other sessions of the account end.
 * Passwords stay in this form's state only (no mutation cache).
 */
export function PasswordSection() {
  const toast = useToast();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = repeat !== '' && next !== repeat;
  const valid = next.length >= MIN && next === repeat;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ ...(current ? { currentPassword: current } : {}), newPassword: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      toast('Passwort geändert. Andere Sitzungen wurden abgemeldet.', 'ok');
    } catch (err) {
      setError(passwordError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec" aria-labelledby="s-password">
      <div className="settings-text">
        <h2 id="s-password">Passwort</h2>
        <p>Nach der Änderung werden alle anderen Sitzungen dieses Kontos abgemeldet.</p>
      </div>
      <form className="settings-body" onSubmit={submit} aria-label="Passwort ändern" noValidate>
        <Input label="Aktuelles Passwort" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} help="Leer lassen, wenn du bisher kein Passwort hast." />
        <Input label="Neues Passwort" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} help={`Mindestens ${MIN} Zeichen.`} />
        <Input label="Neues Passwort wiederholen" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-invalid={mismatch || undefined} />
        {mismatch ? <p className="field-error">Die Passwörter stimmen nicht überein.</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={!valid || busy || !me.data}>
            Passwort ändern
          </Button>
        </div>
      </form>
    </section>
  );
}
