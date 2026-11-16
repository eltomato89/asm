import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, isApiError, queryKeys, type AdminUser } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { RelativeTime } from '../RelativeTime';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
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

function statusError(e: unknown): string {
  if (isApiError(e, 'cannot_disable_self')) return 'Du kannst dein eigenes Konto nicht deaktivieren.';
  if (isApiError(e, 'last_admin')) return 'Das letzte aktive Admin-Konto kann nicht deaktiviert werden.';
  return errorText(e, 'Status konnte nicht geändert werden.');
}

type StatusChange = { user: AdminUser; action: 'disable' | 'enable' };

/** Admin: list of accounts, creating new ones, (de)activating others. The start password never enters a query/mutation cache. */
export function AdminUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.users });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const [change, setChange] = useState<StatusChange | null>(null);
  const setStatus = useMutation({
    mutationFn: (c: StatusChange) => (c.action === 'disable' ? api.disableUser(c.user.id) : api.enableUser(c.user.id)),
    onSuccess: (u, c) => {
      void qc.invalidateQueries({ queryKey: queryKeys.users });
      toast(c.action === 'disable' ? `Konto ${u.username} deaktiviert.` : `Konto ${u.username} aktiviert.`, 'ok');
      setChange(null);
    },
    onError: (e) => toast(statusError(e), 'danger'),
  });
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
                <Th>
                  <span className="visually-hidden">Aktionen</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {users.data.items.map((u) => (
                <Tr key={u.id} className={u.disabledAt !== null ? 'is-archived' : undefined}>
                  <Td>
                    <span className="mono">{u.username}</span> {u.isAdmin ? <Badge>Admin</Badge> : null}{' '}
                    {u.disabledAt !== null ? <Badge tone="danger">deaktiviert</Badge> : null}
                  </Td>
                  <Td className="faint">
                    {[u.hasPassword ? 'Passwort' : null, u.passkeyCount ? `${u.passkeyCount} Passkey${u.passkeyCount > 1 ? 's' : ''}` : null].filter(Boolean).join(', ') || 'keine'}
                  </Td>
                  <Td>
                    <RelativeTime ts={u.createdAt} className="faint" />
                  </Td>
                  <Td className="r">
                    {me.data && u.id !== me.data.id ? (
                      u.disabledAt === null ? (
                        <Button variant="ghost" aria-label={`Konto ${u.username} deaktivieren`} onClick={() => setChange({ user: u, action: 'disable' })}>
                          Deaktivieren
                        </Button>
                      ) : (
                        <Button variant="ghost" aria-label={`Konto ${u.username} aktivieren`} onClick={() => setChange({ user: u, action: 'enable' })}>
                          Aktivieren
                        </Button>
                      )
                    ) : null}
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
      <ConfirmDialog
        open={change !== null}
        onOpenChange={(v) => !v && setChange(null)}
        title={change?.action === 'enable' ? `Konto ${change.user.username} aktivieren?` : `Konto ${change?.user.username ?? ''} deaktivieren?`}
        description={
          change?.action === 'enable'
            ? 'Die Person kann sich danach wieder anmelden. Widerrufene Geräte bleiben widerrufen und müssen neu gekoppelt werden.'
            : 'Die Person wird sofort abgemeldet und kann sich nicht mehr anmelden. Alle ihre Geräte werden widerrufen, offene Anfragen verweigert und Übergaben ungültig.'
        }
        confirmLabel={change?.action === 'enable' ? 'Aktivieren' : 'Deaktivieren'}
        danger={change?.action !== 'enable'}
        busy={setStatus.isPending}
        onConfirm={() => change && setStatus.mutate(change)}
      />
    </section>
  );
}
