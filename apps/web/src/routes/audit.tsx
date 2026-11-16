import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Calendar, Check, ChevronDown, Download, X } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { AUDIT_EVENTS } from '../components/audit/describe';
import { AuditRow } from '../components/audit/AuditRow';
import { SecretFilter } from '../components/audit/SecretFilter';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { api, auditCsvUrl, queryKeys, sessionFetch, type AuditFilter, type AuditRow as AuditRowDto } from '../lib/api';
import { dayGroup, formatCount } from '../lib/format';
import { useNames } from '../lib/names';

export type AuditRange = 'today' | '7' | '30' | 'all';
export type AuditSearch = { deviceId?: string; secretId?: string; project?: string; event?: string; range?: AuditRange };

const RANGES: { value: AuditRange; label: string }[] = [
  { value: 'today', label: 'Heute' },
  { value: '7', label: 'Letzte 7 Tage' },
  { value: '30', label: 'Letzte 30 Tage' },
  { value: 'all', label: 'Gesamt' },
];
const PAGE = 50;

export function validateAuditSearch(s: Record<string, unknown>): AuditSearch {
  const str = (v: unknown) => (typeof v === 'string' && v && v.length <= 200 ? v : undefined);
  const range = RANGES.some((r) => r.value === s.range) ? (s.range as AuditRange) : undefined;
  const out: AuditSearch = {};
  for (const k of ['deviceId', 'secretId', 'project', 'event'] as const) {
    const v = str(s[k]);
    if (v) out[k] = v;
  }
  if (range) out.range = range;
  return out;
}

function rangeFrom(range: AuditRange): number | undefined {
  if (range === 'all') return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range !== 'today') d.setDate(d.getDate() - (Number(range) - 1));
  return d.getTime();
}

function FilterSelect({ label, value, onChange, icon, children }: { label: string; value: string; onChange: (v: string) => void; icon?: ReactNode; children: ReactNode }) {
  return (
    <label className={value ? 'filter is-set' : 'filter'}>
      {icon}
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <ChevronDown className="icon icon-sm" strokeWidth={1.5} aria-hidden />
    </label>
  );
}

export function AuditPage({ search }: { search: AuditSearch }) {
  const navigate = useNavigate();
  const toast = useToast();
  const names = useNames();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const devices = useQuery({ queryKey: queryKeys.devices, queryFn: api.devices });
  const projects = useQuery({ queryKey: queryKeys.projectsAll, queryFn: api.projects });
  const verify = useQuery({ queryKey: queryKeys.auditVerify, queryFn: api.verifyAudit, enabled: me.data?.isAdmin === true, staleTime: 60_000 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = search.range ?? '7';
  const filter = useMemo<AuditFilter>(() => {
    const f: AuditFilter = { limit: PAGE };
    if (search.deviceId) f.deviceId = search.deviceId;
    if (search.secretId) f.secretId = search.secretId;
    if (search.project) f.project = search.project;
    if (search.event) f.event = search.event;
    const from = rangeFrom(range);
    if (from !== undefined) f.from = from;
    return f;
  }, [search.deviceId, search.secretId, search.project, search.event, range]);

  const pages = useInfiniteQuery({
    queryKey: [...queryKeys.audit(filter), 'pages'],
    queryFn: ({ pageParam }) => api.audit(pageParam ? { ...filter, cursor: pageParam } : filter),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows: AuditRowDto[] = pages.data?.pages.flatMap((p) => p.items) ?? [];

  const setSearch = (patch: Partial<AuditSearch>) => {
    setTruncated(false);
    void navigate({ to: '/audit', search: validateAuditSearch({ ...search, ...patch }) });
  };
  const anyFilter = !!(search.deviceId || search.secretId || search.project || search.event);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await sessionFetch(new URL(auditCsvUrl(filter), window.location.origin));
      if (!res.ok) throw new Error(`http_${res.status}`);
      const isTruncated = res.headers.get('x-truncated') === 'true';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asm-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setTruncated(isTruncated);
      toast(isTruncated ? 'CSV exportiert, auf 10.000 Einträge gekürzt.' : 'CSV exportiert.', 'ok');
    } catch {
      toast('Export fehlgeschlagen. Versuche es erneut.', 'danger');
    } finally {
      setExporting(false);
    }
  };

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  let lastDay: number | null = null;
  return (
    <div className="content-wide-inner">
      <div className="page-head">
        <h1>Audit-Log</h1>
        <span className="meta num">{pages.data ? `${formatCount(rows.length)}${pages.hasNextPage ? '+' : ''} Einträge` : ''}</span>
        <div className="actions">
          {me.data?.isAdmin ? <ChainBadge status={verify.data} loading={verify.isPending} failed={verify.isError} head={!anyFilter && range === 'all' ? rows[0]?.hash : undefined} /> : null}
          <Button onClick={() => void exportCsv()} disabled={exporting}>
            <Download className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            Export CSV
          </Button>
        </div>
      </div>
      {truncated ? (
        <p className="notice-line" role="status">
          Der Export enthält nur die neuesten 10.000 Einträge. Grenze Zeitraum oder Filter ein, um ältere Einträge zu exportieren.
        </p>
      ) : null}

      <div className="filters" role="group" aria-label="Filter">
        <FilterSelect label="Gerät" value={search.deviceId ?? ''} onChange={(v) => setSearch({ deviceId: v || undefined })}>
          <option value="">Alle</option>
          {(devices.data?.items ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </FilterSelect>
        <SecretFilter value={search.secretId} onChange={(secretId) => setSearch({ secretId })} />
        <FilterSelect label="Projekt" value={search.project ?? ''} onChange={(v) => setSearch({ project: v || undefined })}>
          <option value="">Alle</option>
          {search.project && !projects.data?.items.some((p) => p.slug === search.project) ? <option value={search.project}>{search.project}</option> : null}
          {(projects.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.slug}>
              {p.displayName}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Ereignis" value={search.event ?? ''} onChange={(v) => setSearch({ event: v || undefined })}>
          <option value="">Alle</option>
          {AUDIT_EVENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </FilterSelect>
        <label className="filter is-set">
          <Calendar className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          Zeitraum
          <select value={range} onChange={(e) => setSearch({ range: e.target.value as AuditRange })}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <ChevronDown className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        </label>
        {anyFilter ? (
          <button type="button" className="reset" onClick={() => setSearch({ deviceId: undefined, secretId: undefined, project: undefined, event: undefined })}>
            Filter zurücksetzen
          </button>
        ) : null}
      </div>

      <div className="table" role="table" aria-label="Audit-Einträge">
        <div className="thead" role="row">
          <span />
          <span role="columnheader">Ereignis</span>
          <span role="columnheader">Code</span>
          <span role="columnheader" className="c-ip">
            IP-Adresse
          </span>
          <span role="columnheader" className="r">
            Zeit
          </span>
        </div>
        {pages.isPending ? (
          <div style={{ padding: 16 }} aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} width={`${85 - i * 9}%`} style={{ margin: '12px 0' }} />
            ))}
          </div>
        ) : pages.isError ? (
          <div className="empty" style={{ margin: 16 }}>
            <strong>Einträge konnten nicht geladen werden</strong>
            Lade die Seite neu.
          </div>
        ) : rows.length === 0 ? (
          <div className="empty" style={{ margin: 16 }}>
            <strong>Keine Einträge für diese Filter</strong>
            Ändere den Zeitraum oder setze die Filter zurück.
          </div>
        ) : (
          rows.map((r) => {
            const g = dayGroup(r.ts);
            const head =
              g.key !== lastDay ? (
                <div className="day" role="row">
                  {g.label}
                  {g.label !== g.date ? <span className="faint">{g.date}</span> : null}
                </div>
              ) : null;
            lastDay = g.key;
            return (
              <Fragment key={r.id}>
                {head}
                <AuditRow row={r} names={names} open={open.has(r.id)} onToggle={() => toggle(r.id)} onOnlySecret={(secretId) => setSearch({ secretId })} />
              </Fragment>
            );
          })
        )}
        <div className="table-foot">
          <span className="num">{pages.data ? `${formatCount(rows.length)} Einträge geladen` : ''}</span>
          <div className="pager">
            {pages.hasNextPage ? (
              <Button onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
                Mehr laden
              </Button>
            ) : rows.length > 0 ? (
              <span>Ende des Protokolls</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChainBadge({ status, loading, failed, head }: { status?: { ok: true } | { ok: false; brokenAtSeq: number }; loading: boolean; failed: boolean; head?: string }) {
  if (loading) return <Skeleton width={120} height={30} />;
  if (failed || !status) return <span className="chain faint">Kette nicht geprüft</span>;
  if (!status.ok) {
    return (
      <span className="chain chain-broken" role="status">
        <X className="icon icon-sm" strokeWidth={2} aria-hidden />
        Kette unterbrochen bei #{status.brokenAtSeq}
      </span>
    );
  }
  return (
    <span className="chain" title="Alle Einträge geprüft: jeder Hash passt zu seinem Vorgänger.">
      <span className="ok">
        <Check className="icon icon-sm" strokeWidth={2} aria-hidden />
        Kette intakt
      </span>
      {head ? <span className="mono">{`${head.slice(0, 4)}…${head.slice(-4)}`}</span> : null}
    </span>
  );
}
