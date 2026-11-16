import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { RelativeTime } from '../components/RelativeTime';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Skeleton } from '../components/ui/Skeleton';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { api, queryKeys, type DeviceDto } from '../lib/api';
import { errorText } from '../lib/errors';

const STATUS: Record<DeviceDto['status'], { label: string; tone: BadgeTone }> = {
  approved: { label: 'aktiv', tone: 'ok' },
  pending: { label: 'wartet auf Freigabe', tone: 'amber' },
  denied: { label: 'abgelehnt', tone: 'neutral' },
  revoked: { label: 'widerrufen', tone: 'danger' },
};

export function DevicesPage() {
  const devices = useQuery({ queryKey: queryKeys.devices, queryFn: api.devices });
  const [revoking, setRevoking] = useState<DeviceDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const revoke = useMutation({
    mutationFn: (d: DeviceDto) => api.revokeDevice(d.id),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      toast(`Zugriff von ${d.name} widerrufen.`, 'ok');
      setRevoking(null);
    },
    onError: (e) => toast(errorText(e, 'Widerrufen fehlgeschlagen.'), 'danger'),
  });

  const items = devices.data?.items ?? [];
  return (
    <div className="content-wide-inner">
      <div className="page-head">
        <h1>Geräte</h1>
        <span className="meta num">{devices.data ? `${items.filter((d) => d.status === 'approved').length} aktiv` : ''}</span>
        <div className="actions">
          <Link to="/activate" className="btn">
            Code eingeben
          </Link>
        </div>
      </div>
      <p className="page-lede">
        Agents koppeln sich über ihren MCP-Client oder mit <span className="mono">asm login</span> im Terminal. Widerrufene Geräte verlieren sofort alle Tokens und offenen Übergaben.
      </p>

      {devices.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : devices.isError ? (
        <p className="empty">Geräte konnten nicht geladen werden. Lade die Seite neu.</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <strong>Noch keine Geräte gekoppelt</strong>
          Starte die Kopplung im MCP-Client oder mit <span className="mono">asm login</span> und gib den angezeigten Code ein.
          <div style={{ marginTop: 12 }}>
            <Link to="/activate" className="btn">
              Code eingeben
            </Link>
          </div>
        </div>
      ) : (
        <Table aria-label="Geräte">
          <THead>
            <Tr>
              <Th>Name</Th>
              <Th>Typ</Th>
              <Th className="col-host">Host</Th>
              <Th>Zuletzt genutzt</Th>
              <Th>Status</Th>
              <Th>
                <span className="visually-hidden">Aktionen</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((d) => (
              <Tr key={d.id} className={d.status === 'revoked' || d.status === 'denied' ? 'is-archived' : undefined}>
                <Td>
                  <DeviceName device={d} />
                </Td>
                <Td>
                  <span className="chip">{d.kind === 'mcp' ? 'MCP' : 'CLI'}</span>
                </Td>
                <Td className="col-host">{d.hostname ? <span className="host">{d.hostname}</span> : <span className="faint">–</span>}</Td>
                <Td>{d.lastUsedAt ? <RelativeTime ts={d.lastUsedAt} className="faint" /> : <span className="faint">nie</span>}</Td>
                <Td>
                  <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                </Td>
                <Td className="r">
                  {d.status === 'approved' || d.status === 'pending' ? (
                    <Button variant="ghost" onClick={() => setRevoking(d)}>
                      Widerrufen
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(v) => !v && setRevoking(null)}
        title={`Zugriff von ${revoking?.name ?? ''} widerrufen?`}
        description="Das Gerät kann danach keine Secrets mehr suchen oder anfragen. Offene Anfragen und Übergaben verfallen sofort. Für einen neuen Zugriff muss es sich neu koppeln."
        confirmLabel="Widerrufen"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </div>
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
      toast('Gerät umbenannt.', 'ok');
    },
    onError: (e) => toast(errorText(e, 'Umbenennen fehlgeschlagen.'), 'danger'),
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
          aria-label="Gerätename"
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
          label={`${device.name} umbenennen`}
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
