import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { api, isApiError, queryKeys } from '../lib/api';
import { AuthCard } from './AuthCard';

const MIN_PASSWORD = 12;

function setupError(e: unknown): string {
  if (isApiError(e, 'invalid_setup_token')) return 'Das Token stimmt nicht. Kopiere es erneut aus dem Container-Log.';
  if (isApiError(e, 'rate_limited')) return 'Zu viele Versuche. Warte eine Minute und versuche es erneut.';
  if (isApiError(e, 'invalid_request') || isApiError(e, 'invalid_username') || isApiError(e, 'invalid_password'))
    return `Benutzername: 3–64 Zeichen aus Buchstaben, Ziffern, . _ -. Passwort: mindestens ${MIN_PASSWORD} Zeichen.`;
  return 'Einrichtung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.';
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
      toast('Konto angelegt. Melde dich jetzt an.', 'ok');
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
    <AuthCard title="ASM einrichten" lede="Lege das erste Konto an. Es erhält Administratorrechte.">
      <form className="consent-sec" onSubmit={submit} noValidate>
        <Input
          label="Einrichtungs-Token"
          mono
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          help={<>Steht beim ersten Start im Container-Log in der Zeile „ASM setup token“.</>}
          required
        />
        <Input label="Benutzername" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} help="3–64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich." required />
        <Input label="Passwort" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} help={`Mindestens ${MIN_PASSWORD} Zeichen. Einen Passkey kannst du danach in den Einstellungen hinzufügen.`} required />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" size="lg" block disabled={busy} style={{ marginTop: 18 }}>
          Konto anlegen
        </Button>
      </form>
    </AuthCard>
  );
}
