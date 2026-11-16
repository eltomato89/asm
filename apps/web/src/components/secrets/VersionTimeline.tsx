import type { ActorRef, SecretMeta, SecretVersionDto } from '@asm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { RelativeTime } from '../RelativeTime';
import { diffValue } from '../requests/RequestCard';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { SecretValue } from './SecretValue';

const FIELD_LABELS = { title: 'Titel', description: 'Beschreibung', tags: 'Tags', envName: 'ENV-Name' } as const;

type Entry =
  | { kind: 'version'; at: number; v: SecretVersionDto }
  | { kind: 'archived' | 'unarchived'; at: number; by: ActorRef; reason?: string; project?: string };

function Actor({ a }: { a: ActorRef }) {
  return a.type === 'device' ? (
    <>
      <span className="host">{a.name}</span> <span className="faint">(Agent)</span>
    </>
  ) : (
    <strong className="actor">{a.name}</strong>
  );
}

/** Version history of a secret, newest first, with archive/unarchive events in between. */
export function VersionTimeline({ secret }: { secret: SecretMeta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const history = useQuery({ queryKey: queryKeys.secretHistory(secret.id), queryFn: () => api.secretHistory(secret.id) });
  const [restoreV, setRestoreV] = useState<number | null>(null);

  const restore = useMutation({
    mutationFn: (v: number) => api.restoreVersion(secret.id, v),
    onSuccess: (meta, v) => {
      qc.setQueryData(queryKeys.secret(secret.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(`Version ${v} wiederhergestellt.`, 'ok');
      setRestoreV(null);
    },
    onError: (e) => toast(errorText(e, 'Wiederherstellen fehlgeschlagen.'), 'danger'),
  });

  if (history.isPending) return <Skeleton width="100%" height={80} />;
  if (history.isError) return <p className="faint">Der Verlauf konnte nicht geladen werden.</p>;

  const latest = Math.max(...history.data.versions.map((v) => v.version));
  const entries: Entry[] = [
    ...history.data.versions.map((v): Entry => ({ kind: 'version', at: v.createdAt, v })),
    ...history.data.events.map((e): Entry => ({ kind: e.type, at: e.at, by: e.by, reason: e.reason, project: e.project })),
  ].sort((a, b) => b.at - a.at || (a.kind === 'version' && b.kind === 'version' ? b.v.version - a.v.version : 0));

  return (
    <>
      <ol className="timeline" aria-label="Verlauf">
        {entries.map((e) =>
          e.kind === 'version' ? (
            <li key={`${secret.id}:v${e.v.version}`} data-entry={`v${e.v.version}`}>
              <div className="tl-head">
                <span className="tl-title num">Version {e.v.version}</span>
                {e.v.version === latest ? <span className="badge">aktuell</span> : null}
                <RelativeTime ts={e.at} className="tl-time" />
              </div>
              <p className="tl-line">
                <Actor a={e.v.changedBy} />
                {e.v.project ? (
                  <>
                    {' '}
                    in <span className="proj">{e.v.project}</span>
                  </>
                ) : null}
                {e.v.restoredFrom !== null ? <span className="muted">, wiederhergestellt aus Version {e.v.restoredFrom}</span> : null}
                {e.v.version === 1 ? <span className="muted">, angelegt</span> : null}
              </p>
              {e.v.reason ? <p className="tl-reason">{e.v.reason}</p> : null}
              {e.v.version > 1 && e.v.restoredFrom === null ? <VersionDiff v={e.v} /> : null}
              <div className="tl-actions">
                <SecretValue
                  key={`${secret.id}:${e.v.version}`}
                  identity={`${secret.id}:${e.v.version}`}
                  compact
                  label={`Wert von Version ${e.v.version}`}
                  reveal={() => api.revealVersion(secret.id, e.v.version)} />
                {e.v.version !== latest && !secret.archived ? (
                  <Button variant="ghost" onClick={() => setRestoreV(e.v.version)}>
                    Wiederherstellen
                  </Button>
                ) : null}
              </div>
            </li>
          ) : (
            <li key={`${e.kind}-${e.at}`} data-entry={e.kind} className="tl-event">
              <div className="tl-head">
                <span className="tl-title">{e.kind === 'archived' ? 'Archiviert' : 'Reaktiviert'}</span>
                <RelativeTime ts={e.at} className="tl-time" />
              </div>
              <p className="tl-line">
                <Actor a={e.by} />
                {e.project ? (
                  <>
                    {' '}
                    in <span className="proj">{e.project}</span>
                  </>
                ) : null}
              </p>
              {e.reason ? <p className="tl-reason">{e.reason}</p> : null}
            </li>
          ),
        )}
      </ol>
      <ConfirmDialog
        open={restoreV !== null}
        onOpenChange={(v) => !v && setRestoreV(null)}
        title={`Version ${restoreV ?? ''} wiederherstellen?`}
        description="Wert und Metadaten dieser Version werden als neue Version übernommen. Der aktuelle Stand bleibt im Verlauf erhalten."
        confirmLabel="Wiederherstellen"
        busy={restore.isPending}
        onConfirm={() => restoreV !== null && restore.mutate(restoreV)}
      />
    </>
  );
}

function VersionDiff({ v }: { v: SecretVersionDto }) {
  const fields = Object.entries(v.metaDiff) as [keyof typeof FIELD_LABELS, { from: unknown; to: unknown }][];
  if (fields.length === 0) return <p className="tl-diff muted">Wert geändert</p>;
  return (
    <div className="tl-diff">
      {fields.map(([f, d]) => (
        <div key={f}>
          <span className="faint">{FIELD_LABELS[f]}:</span> <del>{diffValue(d.from)}</del>
          <span className="arrow" aria-label="wird zu">
            →
          </span>
          <ins>{diffValue(d.to)}</ins>
        </div>
      ))}
    </div>
  );
}
