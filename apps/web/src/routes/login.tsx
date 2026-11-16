import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api, isApiError, queryKeys, type Me } from '../lib/api';
import { AuthCard } from './AuthCard';

function loginError(e: unknown): string {
  if (isApiError(e, 'invalid_credentials')) return 'Benutzername oder Passwort ist falsch.';
  if (isApiError(e, 'rate_limited')) return 'Zu viele Versuche. Warte eine Minute und versuche es erneut.';
  if (isApiError(e, 'invalid_request')) return 'Gib Benutzername und Passwort ein.';
  return 'Anmeldung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.';
}

function passkeyError(e: unknown): string {
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Anmeldung mit Passkey abgebrochen.';
  if (isApiError(e, 'invalid_credentials')) return 'Dieser Passkey ist hier nicht registriert. Melde dich mit Passwort an.';
  if (isApiError(e, 'rate_limited')) return 'Zu viele Versuche. Warte eine Minute und versuche es erneut.';
  return 'Anmeldung mit Passkey fehlgeschlagen.';
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'password' | null>(null);
  const passkeysSupported = browserSupportsWebAuthn();

  const done = async (me: Me) => {
    qc.setQueryData(queryKeys.me, me);
    await navigate({ to: '/' });
  };

  const withPasskey = async () => {
    setBusy('passkey');
    setError(null);
    try {
      const optionsJSON = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON });
      await done(await api.passkeyLoginVerify(response));
    } catch (e) {
      setError(passkeyError(e));
      setBusy(null);
    }
  };

  const withPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('password');
    setError(null);
    try {
      await done(await api.login({ username: username.trim(), password }));
    } catch (err) {
      setError(loginError(err));
      setBusy(null);
    }
  };

  return (
    <AuthCard title="Anmelden" lede={<>bei ASM auf <span className="mono">{window.location.host}</span></>}>
      <div className="consent-sec">
        <Button variant="primary" size="lg" block onClick={withPasskey} disabled={busy !== null || !passkeysSupported}>
          <KeyRound className="icon" strokeWidth={1.5} aria-hidden />
          Mit Passkey anmelden
        </Button>
        {!passkeysSupported ? <p className="help faint" style={{ fontSize: 12, margin: '6px 0 0' }}>Dieser Browser unterstützt keine Passkeys.</p> : null}
        <div className="divider">oder mit Passwort</div>
        <form onSubmit={withPassword} noValidate>
          <Input label="Benutzername" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Input label="Passwort" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" block disabled={busy !== null} style={{ marginTop: 16 }}>
            Anmelden
          </Button>
        </form>
      </div>
    </AuthCard>
  );
}
