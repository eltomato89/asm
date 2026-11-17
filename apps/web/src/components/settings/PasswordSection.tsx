import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { t } from '../../i18n';
import { api, isApiError, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useToast } from '../ui/Toast';

const MIN = 12;

function passwordError(e: unknown): string {
  if (isApiError(e, 'invalid_credentials')) return t.settings.password.wrongCurrent;
  if (isApiError(e, 'current_password_required')) return t.settings.password.currentRequired;
  if (isApiError(e, 'invalid_request')) return t.settings.password.tooShort(MIN);
  return errorText(e, t.settings.password.failed);
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
      toast(t.settings.password.changed, 'ok');
    } catch (err) {
      setError(passwordError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec" aria-labelledby="s-password">
      <div className="settings-text">
        <h2 id="s-password">{t.settings.password.title}</h2>
        <p>{t.settings.password.lede}</p>
      </div>
      <form className="settings-body" onSubmit={submit} aria-label={t.settings.password.formLabel} noValidate>
        <Input label={t.settings.password.current} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} help={t.settings.password.currentHelp} />
        <Input label={t.settings.password.next} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} help={t.settings.password.nextHelp(MIN)} />
        <Input label={t.settings.password.repeat} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-invalid={mismatch || undefined} />
        {mismatch ? <p className="field-error">{t.settings.password.mismatch}</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={!valid || busy || !me.data}>
            {t.settings.password.submit}
          </Button>
        </div>
      </form>
    </section>
  );
}
