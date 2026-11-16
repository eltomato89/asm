import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys, type AuditFilter } from '../../lib/api';
import { useNames } from '../../lib/names';
import { useEventSubscription } from '../../lib/sse';
import { RelativeTime } from '../RelativeTime';
import { MonoChip } from '../ui/MonoChip';
import { Skeleton } from '../ui/Skeleton';
import { describeAudit, isAutoEvent, toneDot } from './describe';

const FEED_FILTER: AuditFilter = { limit: 20 };

/** "Letzte Aktivität": the newest audit entries as sentences with event chips; refreshed by live events. */
export function ActivityFeed({ filter = FEED_FILTER }: { filter?: AuditFilter }) {
  const qc = useQueryClient();
  const names = useNames();
  const feed = useQuery({ queryKey: queryKeys.audit(filter), queryFn: () => api.audit(filter) });
  useEventSubscription(() => void qc.invalidateQueries({ queryKey: queryKeys.auditAll }));

  if (feed.isPending) {
    return (
      <ul className="feed" aria-busy="true" aria-label="Aktivität wird geladen">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <span className="dot" />
            <Skeleton width={`${60 - i * 10}%`} />
            <Skeleton width={110} />
            <Skeleton width={60} />
          </li>
        ))}
      </ul>
    );
  }
  if (feed.isError) return <p className="empty">Die Aktivität konnte nicht geladen werden.</p>;
  if (feed.data.items.length === 0) {
    return (
      <div className="empty">
        <strong>Noch keine Aktivität</strong>
        Abrufe, Freigaben und Änderungen erscheinen hier.
      </div>
    );
  }
  return (
    <ul className="feed">
      {feed.data.items.map((r) => {
        const d = describeAudit(r, names);
        return (
          <li key={r.id}>
            <span className={toneDot(d.tone)} aria-hidden />
            <span className="sentence">
              {d.sentence}
              {d.note ? <span className="note">{d.note}</span> : null}
            </span>
            <MonoChip tone={isAutoEvent(r.event) ? 'amber' : undefined}>{r.event}</MonoChip>
            <RelativeTime ts={r.ts} />
          </li>
        );
      })}
    </ul>
  );
}
