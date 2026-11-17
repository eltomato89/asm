import type { ActorRef, SecretMeta, SecretVersionDto } from '@asm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { t, type Messages } from '../../i18n';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { RelativeTime } from '../RelativeTime';
import { diffValue } from '../requests/RequestCard';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { SecretValue } from './SecretValue';

type Entry =
  | { kind: 'version'; at: number; v: SecretVersionDto }
  | { kind: 'archived' | 'unarchived'; at: number; by: ActorRef; reason?: string; project?: string };

function Actor({ a }: { a: ActorRef }) {
  return a.type === 'device' ? (
    <>
      <span className="host">{a.name}</span> <span className="faint">{t.secrets.timeline.agent}</span>
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
  const m = t.secrets.timeline;

  const restore = useMutation({
    mutationFn: (v: number) => api.restoreVersion(secret.id, v),
    onSuccess: (meta, v) => {
      qc.setQueryData(queryKeys.secret(secret.id), meta);
      void qc.invalidateQueries({ queryKey: queryKeys.secretsAll });
      toast(m.restored(v), 'ok');
      setRestoreV(null);
    },
    onError: (e) => toast(errorText(e, m.restoreFailed), 'danger'),
  });

  if (history.isPending) return <Skeleton width="100%" height={80} />;
  if (history.isError) return <p className="faint">{m.loadFailed}</p>;

  const latest = Math.max(...history.data.versions.map((v) => v.version));
  const entries: Entry[] = [
    ...history.data.versions.map((v): Entry => ({ kind: 'version', at: v.createdAt, v })),
    ...history.data.events.map((e): Entry => ({ kind: e.type, at: e.at, by: e.by, reason: e.reason, project: e.project })),
  ].sort((a, b) => b.at - a.at || (a.kind === 'version' && b.kind === 'version' ? b.v.version - a.v.version : 0));

  return (
    <>
      <ol className="timeline" aria-label={m.label}>
        {entries.map((e) =>
          e.kind === 'version' ? (
            <li key={`${secret.id}:v${e.v.version}`} data-entry={`v${e.v.version}`}>
              <div className="tl-head">
                <span className="tl-title num">{m.version(e.v.version)}</span>
                {e.v.version === latest ? <span className="badge">{m.current}</span> : null}
                <RelativeTime ts={e.at} className="tl-time" />
              </div>
              <p className="tl-line">
                <Actor a={e.v.changedBy} />
                {e.v.project ? (
                  <>
                    {' '}
                    {m.in} <span className="proj">{e.v.project}</span>
                  </>
                ) : null}
                {e.v.restoredFrom !== null ? <span className="muted">{m.restoredFrom(e.v.restoredFrom)}</span> : null}
                {e.v.version === 1 ? <span className="muted">{m.created}</span> : null}
              </p>
              {e.v.reason ? <p className="tl-reason">{e.v.reason}</p> : null}
              {e.v.version > 1 && e.v.restoredFrom === null ? <VersionDiff v={e.v} /> : null}
              <div className="tl-actions">
                <SecretValue
                  key={`${secret.id}:${e.v.version}`}
                  identity={`${secret.id}:${e.v.version}`}
                  compact
                  label={m.valueOfVersion(e.v.version)}
                  reveal={() => api.revealVersion(secret.id, e.v.version)} />
                {e.v.version !== latest && !secret.archived ? (
                  <Button variant="ghost" onClick={() => setRestoreV(e.v.version)}>
                    {m.restore}
                  </Button>
                ) : null}
              </div>
            </li>
          ) : (
            <li key={`${e.kind}-${e.at}`} data-entry={e.kind} className="tl-event">
              <div className="tl-head">
                <span className="tl-title">{e.kind === 'archived' ? m.archived : m.unarchived}</span>
                <RelativeTime ts={e.at} className="tl-time" />
              </div>
              <p className="tl-line">
                <Actor a={e.by} />
                {e.project ? (
                  <>
                    {' '}
                    {m.in} <span className="proj">{e.project}</span>
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
        title={m.restoreTitle(restoreV ?? '')}
        description={m.restoreDescription}
        confirmLabel={m.restore}
        busy={restore.isPending}
        onConfirm={() => restoreV !== null && restore.mutate(restoreV)}
      />
    </>
  );
}

function VersionDiff({ v }: { v: SecretVersionDto }) {
  const fields = Object.entries(v.metaDiff) as [keyof Messages['secrets']['timeline']['fields'], { from: unknown; to: unknown }][];
  if (fields.length === 0) return <p className="tl-diff muted">{t.secrets.timeline.valueChanged}</p>;
  return (
    <div className="tl-diff">
      {fields.map(([f, d]) => (
        <div key={f}>
          <span className="faint">{t.secrets.timeline.fields[f]}:</span> <del>{diffValue(d.from)}</del>
          <span className="arrow" aria-label={t.secrets.timeline.becomes}>
            →
          </span>
          <ins>{diffValue(d.to)}</ins>
        </div>
      ))}
    </div>
  );
}
