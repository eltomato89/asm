import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { t } from '../i18n';
import { api, isApiError, queryKeys, type Me } from '../lib/api';
import { AuthCard } from './AuthCard';

function loginError(e: unknown): string {
  if (isApiError(e, 'invalid_credentials')) return t.auth.login.invalidCredentials;
  if (isApiError(e, 'rate_limited')) return t.auth.rateLimited;
  if (isApiError(e, 'invalid_request')) return t.auth.login.missingFields;
  return t.auth.login.failed;
}

function passkeyError(e: unknown): string {
  if (e instanceof Error && e.name === 'NotAllowedError') return t.auth.login.passkeyCancelled;
  if (isApiError(e, 'invalid_credentials')) return t.auth.login.passkeyUnknown;
  if (isApiError(e, 'rate_limited')) return t.auth.rateLimited;
  return t.auth.login.passkeyFailed;
}

/** `redirectTo`: validated same-origin target to return to (e.g. /connect?req=…). */
export function LoginPage({ redirectTo }: { redirectTo?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'password' | null>(null);
  const passkeysSupported = browserSupportsWebAuthn();

  const done = async (me: Me) => {
    qc.setQueryData(queryKeys.me, me);
    await navigate({ href: redirectTo ?? '/' });
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
    <AuthCard title={t.auth.login.title} lede={<>{t.auth.login.ledeBefore}<span className="mono">{window.location.host}</span></>}>
      <div className="consent-sec">
        <Button variant="primary" size="lg" block onClick={withPasskey} disabled={busy !== null || !passkeysSupported}>
          <KeyRound className="icon" strokeWidth={1.5} aria-hidden />
          {t.auth.login.withPasskey}
        </Button>
        {!passkeysSupported ? <p className="help faint" style={{ fontSize: 12, margin: '6px 0 0' }}>{t.auth.login.noPasskeySupport}</p> : null}
        <div className="divider">{t.auth.login.orPassword}</div>
        <form onSubmit={withPassword} noValidate>
          <Input label={t.auth.username} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Input label={t.auth.password} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" block disabled={busy !== null} style={{ marginTop: 16 }}>
            {t.auth.login.submit}
          </Button>
        </form>
      </div>
    </AuthCard>
  );
}
