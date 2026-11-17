import type { VaultDto } from '@asm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Dialog } from '../components/ui/Dialog';
import { Input } from '../components/ui/Input';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { api, isApiError, queryKeys } from '../lib/api';
import { t } from '../i18n';
import { errorText } from '../lib/errors';
import { vaultLabel } from '../lib/vault';

function memberError(e: unknown): string {
  const m = t.vaults.errors;
  if (isApiError(e, 'user_not_found')) return m.userNotFound;
  if (isApiError(e, 'already_member')) return m.alreadyMember;
  if (isApiError(e, 'last_owner')) return m.lastOwner;
  if (isApiError(e, 'personal_vault')) return m.personalVault;
  return errorText(e, m.membersFailed);
}

export function VaultsPage() {
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <h1>{t.vaults.title}</h1>
        <span className="meta num">{vaults.data ? `${vaults.data.items.length}` : ''}</span>
        <div className="actions">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            {t.vaults.newVault}
          </Button>
        </div>
      </div>
      <p className="page-lede">{t.vaults.lede}</p>
      {vaults.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : vaults.isError ? (
        <p className="empty">{t.vaults.loadError}</p>
      ) : (
        <div className="stack">
          {vaults.data.items.map((v) => (
            <VaultSection key={v.id} vault={v} />
          ))}
        </div>
      )}
      <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function VaultSection({ vault: v }: { vault: VaultDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [removing, setRemoving] = useState<VaultDto['members'][number] | null>(null);
  const canManage = !v.personal && v.role === 'owner';
  const label = vaultLabel(v);

  const add = useMutation({
    mutationFn: () => api.addVaultMember(v.id, { username: username.trim(), role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.vaults });
      toast(t.vaults.added(username.trim()), 'ok');
      setUsername('');
      setRole('member');
    },
    onError: (e) => toast(memberError(e), 'danger'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeVaultMember(v.id, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.vaults });
      toast(t.vaults.removed(removing?.username ?? t.vaults.memberFallback), 'ok');
      setRemoving(null);
    },
    onError: (e) => toast(memberError(e), 'danger'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim()) add.mutate();
  };

  return (
    <section className="block" aria-label={t.vaults.sectionLabel(label)}>
      <header className="block-head">
        <h2>{label}</h2>
        {v.personal ? <Badge>{t.vaults.personalBadge}</Badge> : null}
        <span className="faint">{t.vaults.yourRole(t.vaults.roles[v.role])}</span>
      </header>
      {v.personal ? (
        <p className="block-note">{t.vaults.personalNote}</p>
      ) : null}
      <ul className="members" aria-label={t.vaults.membersOf(label)}>
        {v.members.map((m) => (
          <li key={m.userId}>
            <span className="avatar" aria-hidden>
              {m.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="m-name">{m.username}</span>
            <span className="faint">{t.vaults.roles[m.role]}</span>
            {canManage ? (
              <IconButton label={t.vaults.removeMember(m.username)} className="icon-btn-sm" onClick={() => setRemoving(m)}>
                <X className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <form className="member-add" onSubmit={submit} aria-label={t.vaults.addMemberTo(label)}>
          <Input label={t.vaults.username} autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="field">
            <label htmlFor={`role-${v.id}`}>{t.vaults.role}</label>
            <select id={`role-${v.id}`} className="select" value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'member')}>
              <option value="member">{t.vaults.roles.member}</option>
              <option value="owner">{t.vaults.roles.owner}</option>
            </select>
          </div>
          <Button type="submit" disabled={!username.trim() || add.isPending}>
            {t.vaults.add}
          </Button>
        </form>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t.vaults.removeTitle(removing?.username ?? '', label)}
        description={t.vaults.removeDescription}
        confirmLabel={t.vaults.removeConfirm}
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </section>
  );
}

function CreateVaultDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createVault(name.trim()),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: queryKeys.vaults });
      toast(t.vaults.created(vaultLabel(v)), 'ok');
      setName('');
      onOpenChange(false);
    },
    onError: (e) => toast(errorText(e, t.vaults.createFailed), 'danger'),
  });
  const valid = name.trim().length > 0 && name.trim().length <= 200;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.vaults.newVault}
      description={t.vaults.createDescription}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
          <Button variant="primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            {t.vaults.createSubmit}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <Input label={t.vaults.name} autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  );
}
