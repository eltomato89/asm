import type { AccessRequestDto, StandingRequestDto } from '@asm/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { ActivityFeed } from '../components/audit/ActivityFeed';
import { RelativeTime } from '../components/RelativeTime';
import { RequestQueue } from '../components/requests/RequestQueue';
import { StandingRequestCard } from '../components/requests/StandingRequestCard';
import { Button } from '../components/ui/Button';
import { Kbd, modKeyLabel } from '../components/ui/Kbd';
import { MonoChip } from '../components/ui/MonoChip';
import { Skeleton } from '../components/ui/Skeleton';
import { t } from '../i18n';
import { api, queryKeys } from '../lib/api';
import { useEventSubscription } from '../lib/sse';
import { useNow } from '../lib/time';

const canNotify = () => typeof window !== 'undefined' && 'Notification' in window;

/** Browser notification for new requests while the tab is in the background (only after explicit opt-in). */
function useRequestNotifications() {
  const [permission, setPermission] = useState(() => (canNotify() ? Notification.permission : 'denied'));
  useEventSubscription((e) => {
    const background = () => canNotify() && Notification.permission === 'granted' && document.hidden;
    if (e.type === 'standing_request.created') {
      if (e.data.status !== 'pending' || !background()) return;
      const m = t.standingRequest.notification;
      new Notification(m.title, { body: m.body(e.data.device.name), tag: e.data.id });
      return;
    }
    if (e.type !== 'request.created' || e.data.status !== 'pending' || !background()) return;
    const r = e.data;
    const name = r.secret.envName ?? r.secret.title;
    new Notification(t.requests.notification.title, {
      body: r.kind === 'update' ? t.requests.notification.update(r.device.name, name) : t.requests.notification.read(r.device.name, name, r.project),
      tag: r.id,
    });
  });
  const ask = async () => setPermission(await Notification.requestPermission());
  return { permission, ask };
}

/** Overview (/) and Requests (/requests): open request cards; below either the activity feed or decided requests. */
export function RequestsPage({ variant }: { variant: 'overview' | 'requests' }) {
  const pending = useQuery({ queryKey: queryKeys.requests('pending'), queryFn: () => api.requests('pending') });
  const proposals = useQuery({ queryKey: queryKeys.standingRequests('pending'), queryFn: () => api.standingRequests('pending') });
  const { permission, ask } = useRequestNotifications();
  const openProposals = (proposals.data?.items ?? []).filter((p) => p.status === 'pending');
  const count = (pending.data?.items.length ?? 0) + openProposals.length;

  return (
    <>
      <div className="page-head">
        <h1>{t.requests.title}</h1>
        <span className="meta num">{pending.isPending ? '' : t.requests.openCount(count)}</span>
        {permission === 'default' ? (
          <div className="actions">
            <Button variant="ghost" onClick={() => void ask()}>
              <Bell className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              {t.requests.enableNotifications}
            </Button>
          </div>
        ) : null}
      </div>

      {pending.isPending ? (
        <div className="requests" aria-busy="true">
          <div className="req req-body">
            <Skeleton width="30%" />
            <Skeleton width="70%" height={18} style={{ marginTop: 12 }} />
            <Skeleton width="45%" style={{ marginTop: 10 }} />
          </div>
        </div>
      ) : pending.isError ? (
        <p className="empty">{t.requests.loadFailed}</p>
      ) : (
        <>
          <StandingRequestList items={openProposals} />
          {/* With only proposals open, the queue's "no open requests" state would contradict the cards above. */}
          {openProposals.length === 0 || pending.data.items.length > 0 ? <RequestQueue requests={pending.data.items} /> : null}
        </>
      )}

      <div className="kbd-hint" aria-hidden="true">
        <span>
          <Kbd>A</Kbd> {t.requests.kbd.approve}
        </span>
        <span>
          <Kbd>D</Kbd> {t.requests.kbd.deny}
        </span>
        <span>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> {t.requests.kbd.nextPrev}
        </span>
        <span>
          <Kbd>{modKeyLabel('K')}</Kbd> {t.requests.kbd.commands}
        </span>
      </div>

      {variant === 'overview' ? (
        <>
          <div className="section-head">
            <h2>{t.requests.recentActivity}</h2>
            <Link to="/audit">{t.requests.toAuditLog}</Link>
          </div>
          <ActivityFeed />
        </>
      ) : (
        <DecidedRequests />
      )}
    </>
  );
}

/** Open proposals for standing approvals, above the ordinary request queue. */
function StandingRequestList({ items }: { items: StandingRequestDto[] }) {
  const now = useNow(1000, items.length > 0);
  if (items.length === 0) return null;
  return (
    <div className="requests standing-requests" aria-live="polite">
      {items.map((r) => (
        <StandingRequestCard key={r.id} request={r} now={now} />
      ))}
    </div>
  );
}

type DecidedItem = { kind: 'request'; at: number; r: AccessRequestDto } | { kind: 'standing'; at: number; r: StandingRequestDto };

function DecidedRequests() {
  const all = useQuery({ queryKey: queryKeys.requests('all'), queryFn: () => api.requests('all') });
  const standing = useQuery({ queryKey: queryKeys.standingRequests('all'), queryFn: () => api.standingRequests('all') });
  const decided: DecidedItem[] = [
    ...(all.data?.items ?? []).filter((r) => r.status !== 'pending').map((r): DecidedItem => ({ kind: 'request', at: r.decidedAt ?? r.expiresAt, r })),
    ...(standing.data?.items ?? []).filter((r) => r.status !== 'pending').map((r): DecidedItem => ({ kind: 'standing', at: r.decidedAt ?? r.expiresAt, r })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 50);
  return (
    <>
      <div className="section-head">
        <h2>{t.requests.decided}</h2>
        <Link to="/audit">{t.requests.toAuditLog}</Link>
      </div>
      {all.isPending ? (
        <Skeleton width="100%" height={44} />
      ) : decided.length === 0 ? (
        <div className="empty">
          <strong>{t.requests.decidedEmptyTitle}</strong>
          {t.requests.decidedEmptyBody}
        </div>
      ) : (
        <ul className="feed">
          {decided.map((item) => {
            if (item.kind === 'standing') return <DecidedStanding key={item.r.id} r={item.r} />;
            const r = item.r;
            const status = r.status as Exclude<AccessRequestDto['status'], 'pending'>;
            const dot = status === 'approved' ? 'dot dot-ok' : status === 'denied' ? 'dot dot-danger' : 'dot';
            return (
              <li key={r.id}>
                <span className={dot} aria-hidden />
                <span className="sentence">
                  {t.requests.decidedSentence(
                    <span className="secret">{r.secret.envName ?? r.secret.title}</span>,
                    <span className="host">{r.device.name}</span>,
                    r.kind === 'update' ? null : <span className="proj">{r.project}</span>,
                  )}{' '}
                  <span className="muted">
                    {t.requests.status[status]}
                    {r.auto ? (r.autoSource === 'standing' ? t.requests.viaStanding : t.requests.automatically) : r.decidedBy?.type === 'system' ? t.requests.bySystem : ''}
                  </span>
                </span>
                <MonoChip>{`request.${r.auto ? 'auto_approved' : status}`}</MonoChip>
                <RelativeTime ts={r.decidedAt ?? r.expiresAt} />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function DecidedStanding({ r }: { r: StandingRequestDto }) {
  const status = r.status as Exclude<StandingRequestDto['status'], 'pending'>;
  const dot = status === 'approved' ? 'dot dot-ok' : status === 'denied' ? 'dot dot-danger' : 'dot';
  return (
    <li>
      <span className={dot} aria-hidden />
      <span className="sentence">
        {t.standingRequest.decidedSentence(<span className="host">{r.device.name}</span>)}{' '}
        <span className="muted">
          {t.standingRequest.status[status]}
          {status === 'approved' && r.adjusted ? t.standingRequest.adjustedSuffix : ''}
        </span>
      </span>
      <MonoChip>{`standing_request.${status}`}</MonoChip>
      <RelativeTime ts={r.decidedAt ?? r.expiresAt} />
    </li>
  );
}
