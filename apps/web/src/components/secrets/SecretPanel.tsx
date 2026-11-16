import type { SecretMeta, VaultDto } from '@asm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { formatAbsolute } from '../../lib/format';
import { RelativeTime } from '../RelativeTime';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { ArchiveDialog } from './ArchiveDialog';
import { SecretForm } from './SecretForm';
import { SecretValue } from './SecretValue';
import { VersionTimeline } from './VersionTimeline';

type Props = {
  secretId: string;
  vaults: VaultDto[];
  onClose: () => void;
};

/** Right-hand detail panel: value, metadata, usage, history and lifecycle actions of one secret. */
export function SecretPanel({ secretId, vaults, onClose }: Props) {
  const secret = useQuery({ queryKey: queryKeys.secret(secretId), queryFn: () => api.secret(secretId) });
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setTab('details');
    setEditing(false);
  }, [secretId]);

  const name = secret.data ? (secret.data.envName ?? secret.data.title) : 'Secret';
  return (
    <aside className="panel" aria-label={`Secret ${name}`}>
      <div className="panel-head">
        <div className="panel-title">
          {secret.data ? (
            <>
              <h2 className={secret.data.envName ? 'mono' : undefined}>{name}</h2>
              {secret.data.envName ? <p>{secret.data.title}</p> : null}
            </>
          ) : (
            <Skeleton width={160} height={18} />
          )}
        </div>
        <IconButton label="Panel schließen" onClick={onClose}>
          <X className="icon" strokeWidth={1.5} aria-hidden />
        </IconButton>
      </div>
      {secret.isError ? (
        <p className="panel-body faint">Dieses Secret gibt es nicht oder du hast keinen Zugriff darauf.</p>
      ) : !secret.data ? (
        <div className="panel-body">
          <Skeleton width="100%" height={60} />
        </div>
      ) : editing ? (
        <div className="panel-body">
          <SecretForm secret={secret.data} vaults={vaults} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Ansicht">
            <button type="button" role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>
              Details
            </button>
            <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
              Verlauf
            </button>
          </div>
          <div className="panel-body" role="tabpanel">
            {tab === 'details' ? (
              <SecretDetails secret={secret.data} onEdit={() => setEditing(true)} onDeleted={onClose} />
            ) : (
              <VersionTimeline secret={secret.data} />
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SecretDetails({ secret: s, onEdit, onDeleted }: { secret: SecretMeta; onEdit: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const name = s.envName ?? s.title;

  const unarchive = useMutation({
    mutationFn: () => api.unarchiveSecret(s.id),
    onSuccess: (meta) => {
      qc.setQueryData(queryKeys.secret(s.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(`${name} reaktiviert.`, 'ok');
    },
    onError: (e) => toast(errorText(e, 'Reaktivieren fehlgeschlagen.'), 'danger'),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSecret(s.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: queryKeys.secret(s.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(`${name} gelöscht.`, 'ok');
      setDeleteOpen(false);
      onDeleted();
    },
    onError: (e) => toast(errorText(e, 'Löschen fehlgeschlagen.'), 'danger'),
  });

  return (
    <>
      {s.archived ? (
        <div className="notice" role="note">
          <Archive className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          <div>
            <p>
              Archiviert von {s.archived.by.type === 'device' ? <span className="host">{s.archived.by.name}</span> : <strong>{s.archived.by.name}</strong>}{' '}
              <span title={formatAbsolute(s.archived.at)}>
                <RelativeTime ts={s.archived.at} />
              </span>
              {s.archived.project ? (
                <>
                  {' '}
                  in <span className="proj">{s.archived.project}</span>
                </>
              ) : null}
              .
            </p>
            <p className="req-reason">
              <span className="q">Grund:</span>
              {s.archived.reason}
            </p>
            <Button onClick={() => unarchive.mutate()} disabled={unarchive.isPending} style={{ marginTop: 10 }}>
              Reaktivieren
            </Button>
          </div>
        </div>
      ) : (
        <section className="panel-sec" aria-label="Wert">
          <h3>Wert</h3>
          <SecretValue key={s.id} identity={s.id} label={`Wert von ${name}`} reveal={() => api.revealSecret(s.id)} />
        </section>
      )}

      <section className="panel-sec" aria-label="Details">
        <dl className="kv kv-panel">
          <dt>Tresor</dt>
          <dd>{s.vaultName}</dd>
          <dt>Beschreibung</dt>
          <dd>{s.description || <span className="faint">–</span>}</dd>
          <dt>Tags</dt>
          <dd>{s.tags.length ? s.tags.map((t) => <span key={t} className="chip tag">{t}</span>) : <span className="faint">–</span>}</dd>
          <dt>Klartext an Agenten</dt>
          <dd>{s.allowPlaintextToAgent ? <Badge tone="danger">erlaubt</Badge> : 'nicht erlaubt'}</dd>
          <dt>Herkunft</dt>
          <dd>
            {s.createdBy.type === 'device' ? (
              <>
                <Badge>von Agent</Badge> <span className="host">{s.createdBy.name}</span>
              </>
            ) : (
              <>von {s.createdBy.name} angelegt</>
            )}
          </dd>
          <dt>Geändert</dt>
          <dd>
            <RelativeTime ts={s.updatedAt} />
          </dd>
        </dl>
      </section>

      <UsedBy secretId={s.id} />

      <div className="panel-actions">
        {!s.archived ? (
          <>
            <Button onClick={onEdit}>Bearbeiten</Button>
            <Button onClick={() => setArchiveOpen(true)}>Archivieren</Button>
          </>
        ) : null}
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Löschen
        </Button>
      </div>

      <ArchiveDialog secret={s} open={archiveOpen} onOpenChange={setArchiveOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`${name} endgültig löschen?`}
        description="Der Wert und alle Versionen werden unwiderruflich gelöscht. Agents können ihn danach nicht mehr abrufen. Archivieren ist meist die bessere Wahl."
        confirmLabel="Endgültig löschen"
        danger
        typeToConfirm={s.title}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function UsedBy({ secretId }: { secretId: string }) {
  const used = useQuery({ queryKey: queryKeys.secretProjects(secretId), queryFn: () => api.secretProjects(secretId) });
  return (
    <section className="panel-sec" aria-label="Genutzt von">
      <h3>Genutzt von</h3>
      {used.isPending ? (
        <Skeleton width="60%" />
      ) : !used.data?.items.length ? (
        <p className="faint">Noch von keinem Projekt abgerufen.</p>
      ) : (
        <ul className="mini-list">
          {used.data.items.map(({ project, lastUsedAt }) => (
            <li key={project.id}>
              <Link to="/projects" search={{ selected: project.id }} className="proj">
                {project.displayName}
              </Link>
              <RelativeTime ts={lastUsedAt} className="faint" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
