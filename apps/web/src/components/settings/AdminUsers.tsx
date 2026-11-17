import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { t } from '../../i18n';
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
  if (isApiError(e, 'username_taken')) return t.settings.users.usernameTaken;
  if (isApiError(e, 'invalid_username') || isApiError(e, 'invalid_request')) return t.settings.users.invalidInput;
  if (isApiError(e, 'invalid_password')) return t.settings.users.passwordTooShort;
  return errorText(e, t.settings.users.createFailed);
}

function statusError(e: unknown): string {
  if (isApiError(e, 'cannot_disable_self')) return t.settings.users.cannotDisableSelf;
  if (isApiError(e, 'last_admin')) return t.settings.users.lastAdmin;
  return errorText(e, t.settings.users.statusFailed);
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
      toast(c.action === 'disable' ? t.settings.users.disabledToast(u.username) : t.settings.users.enabledToast(u.username), 'ok');
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
      toast(t.settings.users.created(u.username), 'ok');
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
        <h2 id="s-users">{t.settings.users.title}</h2>
        <p>{t.settings.users.lede}</p>
      </div>
      <div className="settings-body">
        {users.isPending ? (
          <Skeleton width="100%" height={80} />
        ) : users.isError ? (
          <p className="faint">{t.settings.users.loadFailed}</p>
        ) : (
          <Table aria-label={t.settings.users.tableLabel}>
            <THead>
              <Tr>
                <Th>{t.settings.users.colUsername}</Th>
                <Th>{t.settings.users.colSignIn}</Th>
                <Th>{t.settings.users.colCreated}</Th>
                <Th>
                  <span className="visually-hidden">{t.settings.users.colActions}</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {users.data.items.map((u) => (
                <Tr key={u.id} className={u.disabledAt !== null ? 'is-archived' : undefined}>
                  <Td>
                    <span className="mono">{u.username}</span> {u.isAdmin ? <Badge>{t.settings.users.admin}</Badge> : null}{' '}
                    {u.disabledAt !== null ? <Badge tone="danger">{t.settings.users.disabled}</Badge> : null}
                  </Td>
                  <Td className="faint">
                    {[u.hasPassword ? t.settings.users.methodPassword : null, u.passkeyCount ? t.settings.users.methodPasskeys(u.passkeyCount) : null].filter(Boolean).join(', ') ||
                      t.settings.users.methodNone}
                  </Td>
                  <Td>
                    <RelativeTime ts={u.createdAt} className="faint" />
                  </Td>
                  <Td className="r">
                    {me.data && u.id !== me.data.id ? (
                      u.disabledAt === null ? (
                        <Button variant="ghost" aria-label={t.settings.users.disableLabel(u.username)} onClick={() => setChange({ user: u, action: 'disable' })}>
                          {t.settings.users.disable}
                        </Button>
                      ) : (
                        <Button variant="ghost" aria-label={t.settings.users.enableLabel(u.username)} onClick={() => setChange({ user: u, action: 'enable' })}>
                          {t.settings.users.enable}
                        </Button>
                      )
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        <form className="user-create" onSubmit={submit} aria-label={t.settings.users.create} noValidate>
          <h3>{t.settings.users.create}</h3>
          <Input label={t.settings.users.username} autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input
            label={t.settings.users.startPassword}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            help={t.settings.users.startPasswordHelp}
          />
          <label className="check">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> {t.settings.users.administrator}
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" disabled={!valid || busy}>
              {t.settings.users.create}
            </Button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={change !== null}
        onOpenChange={(v) => !v && setChange(null)}
        title={change?.action === 'enable' ? t.settings.users.enableTitle(change.user.username) : t.settings.users.disableTitle(change?.user.username ?? '')}
        description={
          change?.action === 'enable'
            ? t.settings.users.enableText
            : t.settings.users.disableText
        }
        confirmLabel={change?.action === 'enable' ? t.settings.users.enable : t.settings.users.disable}
        danger={change?.action !== 'enable'}
        busy={setStatus.isPending}
        onConfirm={() => change && setStatus.mutate(change)}
      />
    </section>
  );
}
