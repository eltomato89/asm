import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, isApiError, reauth } from '../lib/api';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Input';
import { t } from '../i18n';

type Mode = 'passkey' | 'password';

function errorText(e: unknown): string {
  if (isApiError(e, 'invalid_credentials')) return t.reauth.invalidCredentials;
  if (isApiError(e, 'rate_limited')) return t.reauth.rateLimited;
  if (e instanceof Error && e.name === 'NotAllowedError') return t.reauth.passkeyCancelled;
  return t.reauth.failed;
}

/**
 * Global re-authentication prompt. Registered as the handler for `401 reauth_required`:
 * passkey first, password as fallback; resolves the pending request with true (confirmed) or false (cancelled).
 */
export function ReauthDialog() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('passkey');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    reauth.setHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setMode(browserSupportsWebAuthn() ? 'passkey' : 'password');
          setPassword('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => {
      reauth.setHandler(null);
      // Unmounted while a prompt is pending: fail that request instead of leaving it hanging.
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
    setBusy(false);
  };

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await api.reauthPasskeyOptions();
      const response = await startAuthentication({ optionsJSON });
      await api.reauthPasskeyVerify(response);
      finish(true);
    } catch (e) {
      setBusy(false);
      if (isApiError(e, 'no_passkey')) {
        setMode('password');
        return;
      }
      setError(errorText(e));
    }
  };

  const withPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.reauthPassword(password);
      finish(true);
    } catch (err) {
      setBusy(false);
      setError(errorText(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) finish(false);
      }}
      title={t.reauth.title}
      description={t.reauth.description}
    >
      {mode === 'passkey' ? (
        <div>
          <Button variant="primary" size="lg" block onClick={withPasskey} disabled={busy}>
            <KeyRound className="icon" strokeWidth={1.5} aria-hidden />
            {t.reauth.withPasskey}
          </Button>
          <Button variant="ghost" block onClick={() => setMode('password')} style={{ marginTop: 8 }}>
            {t.reauth.usePassword}
          </Button>
        </div>
      ) : (
        <form onSubmit={withPassword}>
          <Input label={t.reauth.password} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
          <div className="dialog-actions" style={{ padding: '16px 0 0' }}>
            <Button onClick={() => finish(false)}>{t.common.cancel}</Button>
            <Button variant="primary" type="submit" disabled={busy || !password}>
              {t.reauth.confirm}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
