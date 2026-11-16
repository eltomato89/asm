import { ChevronRight, Copy } from 'lucide-react';
import { Fragment, useId } from 'react';
import type { AuditRow as AuditRowDto } from '../../lib/api';
import { formatAbsolute, formatTime } from '../../lib/format';
import type { Names } from '../../lib/names';
import { Button } from '../ui/Button';
import { MonoChip } from '../ui/MonoChip';
import { useToast } from '../ui/Toast';
import { describeAudit, isAutoEvent, toneDot } from './describe';

const dash = <span className="faint">–</span>;

function metaText(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

type Props = {
  row: AuditRowDto;
  names: Names;
  open: boolean;
  onToggle: () => void;
  onOnlySecret?: (secretId: string) => void;
};

/** One audit entry: sentence + mono event code + IP + time; expands to project, reason, device, meta and hashes. */
export function AuditRow({ row: r, names, open, onToggle, onOnlySecret }: Props) {
  const toast = useToast();
  const detailId = useId();
  const d = describeAudit(r, names);
  const meta = Object.entries(r.meta ?? {});
  const requestId = typeof r.meta?.requestId === 'string' ? r.meta.requestId : null;
  const deviceName = names.device(r.deviceId);
  const secretName = names.secret(r.secretId);

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(r.hash);
      toast('Hash kopiert.', 'ok');
    } catch {
      toast('Kopieren nicht möglich.', 'danger');
    }
  };

  return (
    <>
      <button type="button" className="trow" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
        <span className="caret">
          <ChevronRight className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        </span>
        <span className="s">
          <span className={toneDot(d.tone)} aria-hidden />
          <span>
            {d.sentence}
            {d.note ? <span className="note faint"> · {d.note}</span> : null}
          </span>
        </span>
        <span className="codecell">
          <MonoChip tone={isAutoEvent(r.event) ? 'amber' : undefined}>{r.event}</MonoChip>
        </span>
        <span className="ip">{r.ip ?? '–'}</span>
        <time className="r num" dateTime={new Date(r.ts).toISOString()} title={formatAbsolute(r.ts)}>
          {formatTime(r.ts)}
        </time>
      </button>
      <div className={open ? 'detail is-open' : 'detail'} id={detailId} role="region" aria-label={`Details zu Eintrag ${r.seq}`}>
        {open ? (
          <>
            <dl className="kv">
              <dt>Projekt</dt>
              <dd>{r.project ? <span className="proj">{r.project}</span> : dash}</dd>
              <dt>Grund</dt>
              <dd>{r.reason ? <em>{r.reason}</em> : dash}</dd>
              <dt>Gerät</dt>
              <dd>{r.deviceId ? <span className="host">{deviceName ?? r.deviceId}</span> : r.actorType === 'user' ? (r.actorId === names.meId ? 'Du, Web-UI' : 'Web-UI') : dash}</dd>
              <dt>IP-Adresse</dt>
              <dd className="mono">{r.ip ?? '–'}</dd>
              {r.secretId ? (
                <>
                  <dt>Secret</dt>
                  <dd>
                    <span className="secret">{secretName ?? r.secretId}</span>
                  </dd>
                </>
              ) : null}
              <dt>Anfrage</dt>
              <dd>{requestId ? <span className="mono">{requestId}</span> : dash}</dd>
              <dt>Meta</dt>
              <dd>
                {meta.length ? (
                  <div className="meta">
                    {meta.map(([k, v]) => (
                      <Fragment key={k}>
                        <span>{k}</span>
                        <span>{metaText(v)}</span>
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  dash
                )}
              </dd>
              <dt>Zeit</dt>
              <dd className="num">{formatAbsolute(r.ts)}</dd>
              <dt>Eintrag</dt>
              <dd className="mono num">#{r.seq}</dd>
              <dt>Hash</dt>
              <dd className="hash">{r.hash}</dd>
              <dt>Vorheriger Hash</dt>
              <dd className="hash">{r.prevHash}</dd>
            </dl>
            <div className="detail-actions">
              <Button onClick={() => void copyHash()}>
                <Copy className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                Hash kopieren
              </Button>
              {r.secretId && onOnlySecret ? (
                <Button variant="ghost" onClick={() => onOnlySecret(r.secretId!)}>
                  Nur <span className="mono">{secretName ?? r.secretId}</span> zeigen
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
