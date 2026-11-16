import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isApiError, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { RelativeTime } from '../RelativeTime';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../ui/Table';
import { useToast } from '../ui/Toast';

const USERNAME_RE = /^[a-z0-9._-]{3,64}$/i;

function userError(e: unknown): string {
  if (isApiError(e, 'username_taken')) return 'Diesen Benutzernamen gibt es schon.';
  if (isApiError(e, 'invalid_username') || isApiError(e, 'invalid_request')) return 'Benutzername: 3–64 Zeichen aus Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich. Passwort: mindestens 12 Zeichen.';
  if (isApiError(e, 'invalid_password')) return 'Das Passwort braucht mindestens 12 Zeichen.';
  return errorText(e, 'Konto konnte nicht angelegt werden.');
}

/** Admin: list of accounts and creating new ones. The start password never enters a query/mutation cache. */
export function AdminUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.users });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = USERNAME_RE.test(username.trim()) && password.length >= 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const u = await api.createUser({ username: username.trim(), password, isAdmin });
      toast(`Konto ${u.username} angelegt.`, 'ok');
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setError(null);
      void qc.invalidateQueries({ queryKey: queryKeys.users });
    } catch (err) {
      setError(userError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec" aria-labelledby="s-users">
      <div className="settings-text">
        <h2 id="s-users">Nutzerverwaltung</h2>
        <p>Neue Konten erhalten einen eigenen persönlichen Tresor. Teile Secrets über gemeinsame Tresore.</p>
      </div>
      <div className="settings-body">
        {users.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : users.isError ? (
          <p className="faint">Konten konnten nicht geladen werden.</p>
        ) : (
          <Table aria-label="Konten">
            <THead>
              <Tr>
                <Th>Benutzername</Th>
                <Th>Anmeldung</Th>
                <Th>Angelegt</Th>
              </Tr>
            </THead>
            <TBody>
              {users.data.items.map((u) => (
                <Tr key={u.id}>
                  <Td>
                    <span className="mono">{u.username}</span> {u.isAdmin ? <Badge>Admin</Badge> : null}
                  </Td>
                  <Td className="faint">
                    {[u.hasPassword ? 'Passwort' : null, u.passkeyCount ? `${u.passkeyCount} Passkey${u.passkeyCount > 1 ? 's' : ''}` : null].filter(Boolean).join(', ') || 'keine'}
                  </Td>
                  <Td>
                    <RelativeTime ts={u.createdAt} className="faint" />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        <form className="user-create" onSubmit={submit} aria-label="Konto anlegen" noValidate>
          <h3>Konto anlegen</h3>
          <Input label="Benutzername" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input
            label="Startpasswort"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            help="Mindestens 12 Zeichen. Gib es sicher weiter; die Person kann es danach ändern und einen Passkey hinzufügen."
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
            <Button type="submit" variant="primary" disabled={!valid || busy}>
              Konto anlegen
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
