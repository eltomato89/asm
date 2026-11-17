import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { t } from '../i18n';
import { api, isApiError, queryKeys } from '../lib/api';
import { AuthCard } from './AuthCard';

const MIN_PASSWORD = 12;

function setupError(e: unknown): string {
  if (isApiError(e, 'invalid_setup_token')) return t.auth.setup.invalidToken;
  if (isApiError(e, 'rate_limited')) return t.auth.rateLimited;
  if (isApiError(e, 'invalid_request') || isApiError(e, 'invalid_username') || isApiError(e, 'invalid_password'))
    return t.auth.setup.invalidInput(MIN_PASSWORD);
  return t.auth.setup.failed;
}

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toLogin = async () => {
    qc.setQueryData(queryKeys.setupStatus, { needsSetup: false });
    await navigate({ to: '/login' });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup({ token: token.trim(), username: username.trim(), password });
      toast(t.auth.setup.created, 'ok');
      await toLogin();
    } catch (err) {
      if (isApiError(err, 'already_setup')) {
        await toLogin();
        return;
      }
      setError(setupError(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t.auth.setup.title} lede={t.auth.setup.lede}>
      <form className="consent-sec" onSubmit={submit} noValidate>
        <Input
          label={t.auth.setup.token}
          mono
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          help={t.auth.setup.tokenHelp}
          required
        />
        <Input label={t.auth.username} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} help={t.auth.setup.usernameHelp} required />
        <Input label={t.auth.password} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} help={t.auth.setup.passwordHelp(MIN_PASSWORD)} required />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" size="lg" block disabled={busy} style={{ marginTop: 18 }}>
          {t.auth.setup.submit}
        </Button>
      </form>
    </AuthCard>
  );
}
