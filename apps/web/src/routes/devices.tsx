import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { StandingApprovalDialog } from '../components/devices/StandingApprovalDialog';
import { LinkDeviceDialog } from '../components/devices/LinkDeviceDialog';
import { StandingBadge } from '../components/devices/StandingBadge';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Select } from '../components/ui/Field';
import { Skeleton } from '../components/ui/Skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { t } from '../i18n';
import { api, queryKeys, type DeviceDto } from '../lib/api';
import { cx } from '../lib/cx';
import { errorText } from '../lib/errors';
import { vaultLabel } from '../lib/vault';

const STATUS_TONE: Record<DeviceDto['status'], BadgeTone> = {
  approved: 'ok',
  pending: 'amber',
  denied: 'neutral',
  revoked: 'danger',
};

/** An approved CLI attached to a main device: settings come from the main, actions are Unlink / Revoke. */
const isAttached = (d: DeviceDto) => d.kind === 'cli' && d.status === 'approved' && d.linkedTo !== null;

/** Server order, but each main device directly followed by the CLIs attached to it. */
export function groupDevices(items: DeviceDto[]): { device: DeviceDto; attached: boolean }[] {
  const ids = new Set(items.map((d) => d.id));
  const childrenOf = new Map<string, DeviceDto[]>();
  for (const d of items) {
    if (d.linkedTo && ids.has(d.linkedTo.id)) childrenOf.set(d.linkedTo.id, [...(childrenOf.get(d.linkedTo.id) ?? []), d]);
  }
  const out: { device: DeviceDto; attached: boolean }[] = [];
  for (const d of items) {
    if (d.linkedTo && ids.has(d.linkedTo.id)) continue;
    out.push({ device: d, attached: false });
    for (const c of childrenOf.get(d.id) ?? []) out.push({ device: c, attached: true });
  }
  return out;
}

export function DevicesPage() {
  const devices = useQuery({ queryKey: queryKeys.devices, queryFn: api.devices });
  const [revoking, setRevoking] = useState<DeviceDto | null>(null);
  const [alsoRevokeAttached, setAlsoRevokeAttached] = useState(true);
  const [standingFor, setStandingFor] = useState<DeviceDto | null>(null);
  const [linking, setLinking] = useState<DeviceDto | null>(null);
  const [unlinking, setUnlinking] = useState<DeviceDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const items = devices.data?.items ?? [];
  const mains = items.filter((d) => d.kind === 'mcp' && d.status === 'approved');
  const attachedTo = (main: DeviceDto) => items.filter((d) => isAttached(d) && d.linkedTo?.id === main.id);
  const revokingAttached = revoking ? attachedTo(revoking) : [];

  const revoke = useMutation({
    mutationFn: (v: { device: DeviceDto; attached?: 'revoke' | 'detach' }) => api.revokeDevice(v.device.id, v.attached),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      toast(t.devices.revoked(d.name), 'ok');
      setRevoking(null);
    },
    onError: (e) => toast(errorText(e, t.devices.revokeFailed), 'danger'),
  });

  const unlink = useMutation({
    mutationFn: (d: DeviceDto) => api.unlinkDevice(d.id),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      toast(t.devices.unlinked(d.name), 'ok');
      setUnlinking(null);
    },
    onError: (e) => toast(errorText(e, t.devices.unlinkFailed), 'danger'),
  });

  const openRevoke = (d: DeviceDto) => {
    setAlsoRevokeAttached(true);
    setRevoking(d);
  };

  return (
    <div className="content-wide-inner">
      <div className="page-head">
        <h1>{t.devices.title}</h1>
        <span className="meta num">{devices.data ? t.devices.activeCount(items.filter((d) => d.status === 'approved').length) : ''}</span>
        <div className="actions">
          <Link to="/activate" className="btn">
            {t.devices.enterCode}
          </Link>
        </div>
      </div>
      <p className="page-lede">
        {t.devices.ledeBefore}
        <span className="mono">asm login</span>
        {t.devices.ledeAfter}
      </p>

      {devices.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : devices.isError ? (
        <p className="empty">{t.devices.loadFailed}</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <strong>{t.devices.emptyTitle}</strong>
          {t.devices.emptyBefore}
          <span className="mono">asm login</span>
          {t.devices.emptyAfter}
          <div style={{ marginTop: 12 }}>
            <Link to="/activate" className="btn">
              {t.devices.enterCode}
            </Link>
          </div>
        </div>
      ) : (
        <Table aria-label={t.devices.title}>
          <THead>
            <Tr>
              <Th>{t.devices.col.name}</Th>
              <Th>{t.devices.col.kind}</Th>
              <Th className="col-host">{t.devices.col.host}</Th>
              <Th>{t.devices.col.lastUsed}</Th>
              <Th className="col-vault">{t.devices.col.defaultVault}</Th>
              <Th>{t.devices.col.status}</Th>
              <Th>
                <span className="visually-hidden">{t.devices.col.actions}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {groupDevices(items).map(({ device: d, attached: nested }) => {
              const attached = isAttached(d);
              const mainName = d.linkedTo?.name ?? '';
              const descId = `dev-attached-${d.id}`;
              return (
                <Tr
                  key={d.id}
                  className={cx(nested && 'is-attached', (d.status === 'revoked' || d.status === 'denied') && 'is-archived') || undefined}
                  aria-describedby={nested ? descId : undefined}
                >
                  <Td>
                    <span className="device-name">
                      {nested ? (
                        <span className="attached-mark" aria-hidden="true">
                          ↳
                        </span>
                      ) : null}
                      <DeviceName device={d} />
                      {nested ? (
                        <span id={descId} className="visually-hidden">
                          {t.devices.attachedTo(mainName)}
                        </span>
                      ) : null}
                    </span>
                  </Td>
                  <Td>
                    <span className="chip">{d.kind === 'mcp' ? 'MCP' : 'CLI'}</span>
                  </Td>
                  <Td className="col-host">{d.hostname ? <span className="host">{d.hostname}</span> : <span className="faint">–</span>}</Td>
                  <Td>{d.lastUsedAt ? <RelativeTime ts={d.lastUsedAt} className="faint" /> : <span className="faint">{t.devices.never}</span>}</Td>
                  <Td className="col-vault">
                    {attached ? (
                      <span className="muted inherited-vault" title={t.devices.settingsFrom(mainName)}>
                        {d.defaultVault ? vaultLabel(d.defaultVault) : '–'}
                      </span>
                    ) : d.status === 'approved' && d.defaultVault ? (
                      <DefaultVaultSelect device={d} />
                    ) : (
                      <span className="faint">–</span>
                    )}
                  </Td>
                  <Td>
                    <span className="device-status">
                      <Badge tone={STATUS_TONE[d.status]}>{t.devices.status[d.status]}</Badge>
                      {d.status === 'approved' && d.standingApproval && !attached ? <StandingBadge summary={d.standingApproval} /> : null}
                    </span>
                  </Td>
                  <Td className="r">
                    <span className="device-actions">
                      {attached ? (
                        <Button variant="ghost" aria-label={t.devices.unlinkAria(d.name)} onClick={() => setUnlinking(d)}>
                          {t.devices.unlink}
                        </Button>
                      ) : null}
                      {d.status === 'approved' && d.kind === 'cli' && !attached && mains.length > 0 ? (
                        <Button variant="ghost" aria-label={t.devices.linkAria(d.name)} onClick={() => setLinking(d)}>
                          {t.devices.link}
                        </Button>
                      ) : null}
                      {d.status === 'approved' && !attached ? (
                        <Button variant="ghost" aria-label={t.standing.openAria(d.name)} onClick={() => setStandingFor(d)}>
                          {t.standing.open}
                        </Button>
                      ) : null}
                      {d.status === 'approved' || d.status === 'pending' ? (
                        <Button variant="ghost" onClick={() => openRevoke(d)}>
                          {t.devices.revoke}
                        </Button>
                      ) : null}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}

      <StandingApprovalDialog device={standingFor} onOpenChange={(v) => !v && setStandingFor(null)} />
      <LinkDeviceDialog device={linking} mains={mains} onOpenChange={(v) => !v && setLinking(null)} />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(v) => !v && setRevoking(null)}
        title={t.devices.revokeTitle(revoking?.name ?? '')}
        description={t.devices.revokeText}
        confirmLabel={t.devices.revoke}
        danger
        busy={revoke.isPending}
        onConfirm={() =>
          revoking && revoke.mutate({ device: revoking, ...(revokingAttached.length > 0 ? { attached: alsoRevokeAttached ? 'revoke' : 'detach' } : {}) })
        }
      >
        {revokingAttached.length > 0 ? (
          <div className="revoke-attached">
            <label className="check">
              <input type="checkbox" checked={alsoRevokeAttached} onChange={(e) => setAlsoRevokeAttached(e.target.checked)} />
              {t.devices.revokeAttached(revokingAttached.map((c) => c.name))}
            </label>
            {!alsoRevokeAttached ? <p className="help">{t.devices.revokeAttachedHelp}</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(v) => !v && setUnlinking(null)}
        title={t.devices.unlinkTitle(unlinking?.name ?? '', unlinking?.linkedTo?.name ?? '')}
        description={t.devices.unlinkText}
        confirmLabel={t.devices.unlink}
        busy={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking)}
      />
    </div>
  );
}

/** Compact select for an approved device's default vault (where it creates secrets without naming a vault). */
function DefaultVaultSelect({ device }: { device: DeviceDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const current = device.defaultVault!;
  const set = useMutation({
    mutationFn: (vaultId: string | null) => api.setDeviceDefaultVault(device.id, vaultId),
    onSuccess: (d) => {
      qc.setQueryData<{ items: DeviceDto[] }>(queryKeys.devices, (old) => old && { items: old.items.map((x) => (x.id === d.id ? d : x)) });
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      toast(t.devices.defaultVaultChanged(d.name, d.defaultVault ? vaultLabel(d.defaultVault) : t.vaults.personal), 'ok');
    },
    onError: (e) => toast(errorText(e, t.devices.defaultVaultFailed), 'danger'),
  });
  const items = vaults.data?.items ?? [];
  // The current default is always an option, even before the vault list has loaded.
  const options = items.some((v) => v.id === current.id) ? items : [current, ...items];
  return (
    <Select
      compact
      label={t.devices.defaultVaultLabel(device.name)}
      title={t.devices.defaultVaultHelp}
      value={current.id}
      disabled={set.isPending}
      onChange={(e) => {
        const v = options.find((o) => o.id === e.target.value);
        if (!v || v.id === current.id) return;
        set.mutate(v.personal ? null : v.id);
      }}
    >
      {options.map((v) => (
        <option key={v.id} value={v.id}>
          {vaultLabel(v)}
        </option>
      ))}
    </Select>
  );
}

function DeviceName({ device }: { device: DeviceDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const rename = useMutation({
    mutationFn: (n: string) => api.renameDevice(device.id, n),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      setEditing(false);
      toast(t.devices.renamed, 'ok');
    },
    onError: (e) => toast(errorText(e, t.devices.renameFailed), 'danger'),
  });
  const save = () => {
    const n = name.trim();
    if (!n || n === device.name) return setEditing(false);
    rename.mutate(n);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      setName(device.name);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <span className="inline-edit">
        <input
          className="inline-input mono"
          aria-label={t.devices.deviceName}
          autoFocus
          maxLength={100}
          value={name}
          disabled={rename.isPending}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKey}
          onBlur={save}
        />
      </span>
    );
  }
  return (
    <span className="inline-edit">
      <span className="host">{device.name}</span>
      {device.status !== 'revoked' ? (
        <IconButton
          label={t.devices.rename(device.name)}
          className="icon-btn-sm"
          onClick={() => {
            setName(device.name);
            setEditing(true);
          }}
        >
          <Pencil className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        </IconButton>
      ) : null}
    </span>
  );
}
