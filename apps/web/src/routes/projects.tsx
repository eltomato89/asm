import type { ProjectDto } from '@asm/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ActivityFeed } from '../components/audit/ActivityFeed';
import { RelativeTime } from '../components/RelativeTime';
import { Button, IconButton } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Select } from '../components/ui/Field';
import { Skeleton } from '../components/ui/Skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { api, isApiError, queryKeys } from '../lib/api';
import { cx } from '../lib/cx';
import { errorText } from '../lib/errors';
import { t } from '../i18n';

export function ProjectsPage({ selected }: { selected?: string }) {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: queryKeys.projectsAll, queryFn: api.projects });
  const items = projects.data?.items ?? [];
  // Per-project usage counts come from the detail endpoint (small lists: one request per project).
  const details = useQueries({
    queries: items.map((p) => ({ queryKey: queryKeys.project(p.id), queryFn: () => api.project(p.id) })),
  });
  const select = (id?: string) => void navigate({ to: '/projects', search: id ? { selected: id } : {} });

  return (
    <div className={cx('split', selected && 'has-panel')}>
      <div className="split-main">
        <div className="page-head">
          <h1>{t.projects.title}</h1>
          <span className="meta num">{projects.data ? `${items.length}` : ''}</span>
        </div>
        <p className="page-lede">{t.projects.lede}</p>
        {projects.isPending ? (
          <Skeleton width="100%" height={120} />
        ) : projects.isError ? (
          <p className="empty">{t.projects.loadError}</p>
        ) : items.length === 0 ? (
          <div className="empty">
            <strong>{t.projects.emptyTitle}</strong>
            {t.projects.emptyHint}
          </div>
        ) : (
          <Table aria-label={t.projects.title}>
            <THead>
              <Tr>
                <Th>{t.projects.columns.name}</Th>
                <Th>{t.projects.columns.lastSeen}</Th>
                <Th className="r">{t.projects.columns.secrets}</Th>
                <Th className="r">{t.projects.columns.devices}</Th>
              </Tr>
            </THead>
            <TBody>
              {items.map((p, i) => {
                const d = details[i]?.data;
                return (
                  <tr key={p.id} className={cx('row-link', p.id === selected && 'is-active')} onClick={() => select(p.id)}>
                    <Td>
                      <button type="button" className="row-main" aria-current={p.id === selected ? 'true' : undefined}>
                        <span className="proj name">{p.displayName}</span>
                      </button>
                    </Td>
                    <Td>
                      <RelativeTime ts={p.lastSeen} className="faint" />
                    </Td>
                    <Td className="r num">{d ? d.secrets.length : '·'}</Td>
                    <Td className="r num">{d ? d.devices.length : '·'}</Td>
                  </tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>
      {selected ? <ProjectPanel projectId={selected} projects={items} onClose={() => select()} onMerged={(into) => select(into)} /> : null}
    </div>
  );
}

function ProjectPanel({ projectId, projects, onClose, onMerged }: { projectId: string; projects: ProjectDto[]; onClose: () => void; onMerged: (into: string) => void }) {
  const detail = useQuery({ queryKey: queryKeys.project(projectId), queryFn: () => api.project(projectId) });
  const [mergeOpen, setMergeOpen] = useState(false);
  const p = detail.data?.project;
  return (
    <aside className="panel" aria-label={t.projects.panelLabel(p?.displayName ?? '')}>
      <div className="panel-head">
        <div className="panel-title">
          {p ? <h2 className="proj">{p.displayName}</h2> : <Skeleton width={160} height={18} />}
          {p ? (
            <p>
              {t.projects.firstSeen} <RelativeTime ts={p.firstSeen} />
            </p>
          ) : null}
        </div>
        <IconButton label={t.projects.closePanel} onClick={onClose}>
          <X className="icon" strokeWidth={1.5} aria-hidden />
        </IconButton>
      </div>
      <div className="panel-body">
        {detail.isError ? (
          <p className="faint">{t.projects.notFound}</p>
        ) : !detail.data ? (
          <Skeleton width="100%" height={80} />
        ) : (
          <>
            <section className="panel-sec" aria-label={t.projects.usedSecrets}>
              <h3>{t.projects.usedSecrets}</h3>
              {detail.data.secrets.length === 0 ? (
                <p className="faint">{t.projects.noSecrets}</p>
              ) : (
                <ul className="mini-list">
                  {detail.data.secrets.map(({ secret, lastUsedAt }) => (
                    <li key={secret.id}>
                      <Link to="/secrets" search={{ selected: secret.id }} className={secret.envName ? 'secret' : undefined}>
                        {secret.envName ?? secret.title}
                      </Link>
                      <RelativeTime ts={lastUsedAt} className="faint" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel-sec" aria-label={t.projects.devices}>
              <h3>{t.projects.devices}</h3>
              {detail.data.devices.length === 0 ? (
                <p className="faint">{t.projects.noDevices}</p>
              ) : (
                <ul className="mini-list">
                  {detail.data.devices.map(({ device, lastUsedAt }) => (
                    <li key={device.id}>
                      <span className="host">{device.name}</span>
                      <RelativeTime ts={lastUsedAt} className="faint" />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel-sec" aria-label={t.projects.recent}>
              <h3>{t.projects.recent}</h3>
              <ActivityFeed filter={{ project: detail.data.project.slug, limit: 10 }} />
              <Link to="/audit" search={{ project: detail.data.project.slug }} className="more-link">
                {t.projects.allInAudit}
              </Link>
            </section>
            <div className="panel-actions">
              <Button onClick={() => setMergeOpen(true)} disabled={projects.length < 2}>
                {t.projects.mergeWith}
              </Button>
            </div>
            <MergeDialog
              from={detail.data.project}
              targets={projects.filter((x) => x.id !== projectId)}
              open={mergeOpen}
              onOpenChange={setMergeOpen}
              onMerged={onMerged}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function MergeDialog({
  from,
  targets,
  open,
  onOpenChange,
  onMerged,
}: {
  from: ProjectDto;
  targets: ProjectDto[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMerged: (into: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [into, setInto] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setInto(targets[0]?.id ?? '');
      setError(null);
    }
  }, [open, targets]);

  const merge = useMutation({
    mutationFn: () => api.mergeProject(from.id, into),
    onSuccess: (target) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectsAll });
      toast(t.projects.merged(from.displayName, target.displayName), 'ok');
      onOpenChange(false);
      onMerged(target.id);
    },
    onError: (e) =>
      setError(
        isApiError(e, 'merge_not_allowed')
          ? t.projects.mergeNotAllowed
          : errorText(e, t.projects.mergeFailed),
      ),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.projects.mergeTitle(from.displayName)}
      description={t.projects.mergeDescription}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>{t.common.cancel}</Button>
          <Button variant="primary" disabled={!into || merge.isPending} onClick={() => merge.mutate()}>
            {t.projects.merge}
          </Button>
        </>
      }
    >
      <Select label={t.projects.target} value={into} onChange={(e) => setInto(e.target.value)}>
        {targets.map((x) => (
          <option key={x.id} value={x.id}>
            {x.displayName}
          </option>
        ))}
      </Select>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
