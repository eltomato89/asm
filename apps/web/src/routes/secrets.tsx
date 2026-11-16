import type { SecretMeta } from '@asm/shared';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Search, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { SecretForm } from '../components/secrets/SecretForm';
import { SecretPanel } from '../components/secrets/SecretPanel';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { api, queryKeys, type SecretStatus } from '../lib/api';
import { cx } from '../lib/cx';
import { formatAbsolute } from '../lib/format';
import { useCurrentVault } from '../lib/vault';

const PAGE = 100;

const FILTERS: { status: SecretStatus; label: string }[] = [
  { status: 'active', label: 'Aktiv' },
  { status: 'archived', label: 'Archiviert' },
  { status: 'all', label: 'Alle' },
];

export function SecretsPage({ selected }: { selected?: string }) {
  const navigate = useNavigate();
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const { vault } = useCurrentVault(vaults.data?.items);
  const [status, setStatus] = useState<SecretStatus>('active');
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [creating, setCreating] = useState(false);
  const list = useInfiniteQuery({
    queryKey: [...queryKeys.secrets(status, query, vault?.id), 'pages'],
    queryFn: ({ pageParam }) => api.secrets(status, query, { vault: vault?.id, cursor: pageParam || undefined, limit: PAGE }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    enabled: vault !== undefined,
    placeholderData: (prev) => prev,
  });

  const select = (id?: string) => {
    setCreating(false);
    void navigate({ to: '/secrets', search: id ? { selected: id } : {} });
  };
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const panelOpen = creating || !!selected;

  return (
    <div className={cx('split', panelOpen && 'has-panel')}>
      <div className="split-main">
        <div className="page-head">
          <h1>Secrets</h1>
          <span className="meta num">{list.data ? `${items.length}${list.hasNextPage ? '+' : ''} in ${vault?.name ?? ''}` : ''}</span>
          <div className="actions">
            <Button
              variant="primary"
              onClick={() => {
                setCreating(true);
                void navigate({ to: '/secrets', search: {} });
              }}
            >
              <Plus className="icon icon-sm" strokeWidth={1.5} aria-hidden />
              Neues Secret
            </Button>
          </div>
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="Status">
            {FILTERS.map((f) => (
              <button key={f.status} type="button" aria-pressed={status === f.status} onClick={() => setStatus(f.status)}>
                {f.label}
              </button>
            ))}
          </div>
          <label className="search">
            <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            <input type="search" placeholder="Titel, ENV-Name, Tag" aria-label="Secrets durchsuchen" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>

        {list.isPending ? (
          <div className="data-table" aria-busy="true" style={{ padding: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} width={`${80 - i * 12}%`} style={{ margin: '10px 0' }} />
            ))}
          </div>
        ) : list.isError ? (
          <p className="empty">Secrets konnten nicht geladen werden. Lade die Seite neu.</p>
        ) : items.length === 0 ? (
          <EmptySecrets status={status} query={query} onCreate={() => setCreating(true)} />
        ) : (
          <Table aria-label="Secrets">
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th className="col-tags">Tags</Th>
                <Th className="r">Geändert</Th>
              </Tr>
            </THead>
            <TBody>
              {items.map((s) => (
                <SecretRow key={s.id} s={s} active={s.id === selected} onSelect={() => select(s.id)} />
              ))}
            </TBody>
          </Table>
        )}
        {list.hasNextPage ? (
          <div className="list-more">
            <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              Mehr laden
            </Button>
          </div>
        ) : null}
      </div>

      {creating ? (
        <aside className="panel" aria-label="Neues Secret">
          <div className="panel-head">
            <div className="panel-title">
              <h2>Neues Secret</h2>
              {vault ? <p>in {vault.name}</p> : null}
            </div>
            <IconButton label="Panel schließen" onClick={() => setCreating(false)}>
              <X className="icon" strokeWidth={1.5} aria-hidden />
            </IconButton>
          </div>
          <div className="panel-body">
            <SecretForm vaults={vaults.data?.items ?? []} defaultVaultId={vault?.id} onDone={(m) => select(m.id)} onCancel={() => setCreating(false)} />
          </div>
        </aside>
      ) : selected ? (
        <SecretPanel key={selected} secretId={selected} vaults={vaults.data?.items ?? []} onClose={() => select()} />
      ) : null}
    </div>
  );
}

function SecretRow({ s, active, onSelect }: { s: SecretMeta; active: boolean; onSelect: () => void }) {
  return (
    <tr className={cx('row-link', active && 'is-active', s.archived && 'is-archived')} onClick={onSelect}>
      <Td>
        <button type="button" className="row-main" aria-current={active ? 'true' : undefined}>
          <span className={s.envName ? 'mono name' : 'name'}>{s.envName ?? s.title}</span>
          {s.envName ? <span className="sub">{s.title}</span> : null}
        </button>
        <span className="row-badges">
          {s.archived ? (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <span className="badge" title={s.archived.reason} tabIndex={0}>
                  Archiviert
                </span>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip" sideOffset={4}>
                  {s.archived.reason}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ) : null}
          {s.createdBy.type === 'device' ? <Badge title={`angelegt von ${s.createdBy.name}`}>von Agent</Badge> : null}
        </span>
      </Td>
      <Td className="col-tags">
        {s.tags.slice(0, 3).map((t) => (
          <span key={t} className="chip tag">
            {t}
          </span>
        ))}
        {s.tags.length > 3 ? <span className="faint"> +{s.tags.length - 3}</span> : null}
      </Td>
      <Td className="r" title={formatAbsolute(s.updatedAt)}>
        <RelativeTime ts={s.updatedAt} className="faint" />
      </Td>
    </tr>
  );
}

function EmptySecrets({ status, query, onCreate }: { status: SecretStatus; query: string; onCreate: () => void }) {
  if (query) {
    return (
      <div className="empty">
        <strong>Keine Treffer für „{query}“</strong>
        Prüfe die Schreibweise oder wechsle zu „Alle“.
      </div>
    );
  }
  if (status === 'archived') {
    return (
      <div className="empty">
        <strong>Keine archivierten Secrets</strong>
        Archivierte Secrets erscheinen hier und lassen sich reaktivieren.
      </div>
    );
  }
  return (
    <div className="empty">
      <strong>Noch keine Secrets in diesem Tresor</strong>
      Lege das erste an oder lass einen Agenten eins anlegen.
      <div style={{ marginTop: 12 }}>
        <Button onClick={onCreate}>Neues Secret</Button>
      </div>
    </div>
  );
}
