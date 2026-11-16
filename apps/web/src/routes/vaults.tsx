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
import { errorText } from '../lib/errors';

const ROLE = { owner: 'Eigentümer', member: 'Mitglied' } as const;

function memberError(e: unknown): string {
  if (isApiError(e, 'user_not_found')) return 'Diesen Benutzernamen gibt es nicht.';
  if (isApiError(e, 'already_member')) return 'Diese Person ist bereits Mitglied.';
  if (isApiError(e, 'last_owner')) return 'Der letzte Eigentümer kann nicht entfernt werden. Ernenne zuerst einen weiteren.';
  if (isApiError(e, 'personal_vault')) return 'Der persönliche Tresor lässt sich nicht teilen.';
  return errorText(e, 'Mitglieder konnten nicht geändert werden.');
}

export function VaultsPage() {
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <h1>Tresore</h1>
        <span className="meta num">{vaults.data ? `${vaults.data.items.length}` : ''}</span>
        <div className="actions">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            Neuer Tresor
          </Button>
        </div>
      </div>
      <p className="page-lede">Ein Tresor bündelt Secrets und legt fest, wer sie sehen und freigeben darf. Der Auto-Modus lässt sich auf einzelne Tresore beschränken.</p>
      {vaults.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : vaults.isError ? (
        <p className="empty">Tresore konnten nicht geladen werden.</p>
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

  const add = useMutation({
    mutationFn: () => api.addVaultMember(v.id, { username: username.trim(), role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.vaults });
      toast(`${username.trim()} hinzugefügt.`, 'ok');
      setUsername('');
      setRole('member');
    },
    onError: (e) => toast(memberError(e), 'danger'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.removeVaultMember(v.id, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.vaults });
      toast(`${removing?.username ?? 'Mitglied'} entfernt.`, 'ok');
      setRemoving(null);
    },
    onError: (e) => toast(memberError(e), 'danger'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (username.trim()) add.mutate();
  };

  return (
    <section className="block" aria-label={`Tresor ${v.name}`}>
      <header className="block-head">
        <h2>{v.name}</h2>
        {v.personal ? <Badge>persönlich</Badge> : null}
        <span className="faint">Deine Rolle: {ROLE[v.role]}</span>
      </header>
      {v.personal ? (
        <p className="block-note">Dein persönlicher Tresor. Nur du hast Zugriff, er lässt sich nicht teilen.</p>
      ) : null}
      <ul className="members" aria-label={`Mitglieder von ${v.name}`}>
        {v.members.map((m) => (
          <li key={m.userId}>
            <span className="avatar" aria-hidden>
              {m.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="m-name">{m.username}</span>
            <span className="faint">{ROLE[m.role]}</span>
            {canManage ? (
              <IconButton label={`${m.username} entfernen`} className="icon-btn-sm" onClick={() => setRemoving(m)}>
                <X className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <form className="member-add" onSubmit={submit} aria-label={`Mitglied zu ${v.name} hinzufügen`}>
          <Input label="Benutzername" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="field">
            <label htmlFor={`role-${v.id}`}>Rolle</label>
            <select id={`role-${v.id}`} className="select" value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'member')}>
              <option value="member">Mitglied</option>
              <option value="owner">Eigentümer</option>
            </select>
          </div>
          <Button type="submit" disabled={!username.trim() || add.isPending}>
            Hinzufügen
          </Button>
        </form>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`${removing?.username ?? ''} aus ${v.name} entfernen?`}
        description="Die Person sieht die Secrets dieses Tresors danach nicht mehr. Ihre offenen Anfragen dazu werden verweigert."
        confirmLabel="Entfernen"
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
      toast(`Tresor ${v.name} angelegt.`, 'ok');
      setName('');
      onOpenChange(false);
    },
    onError: (e) => toast(errorText(e, 'Tresor konnte nicht angelegt werden.'), 'danger'),
  });
  const valid = name.trim().length > 0 && name.trim().length <= 200;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Neuer Tresor"
      description="Du wirst Eigentümer und kannst danach weitere Personen hinzufügen."
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button variant="primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            Tresor anlegen
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
        <Input label="Name" autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  );
}
