import type { AccessRequestDto, RequestMetaDiff } from '@asm/shared';
import { FileText, FolderClosed, Terminal } from 'lucide-react';
import { forwardRef } from 'react';
import { cx } from '../../lib/cx';
import { formatAbsolute, formatShortTime } from '../../lib/format';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';

export type Decision = 'approve' | 'deny';

const FIELD_LABELS: Record<keyof RequestMetaDiff, string> = {
  title: 'Titel',
  description: 'Beschreibung',
  tags: 'Tags',
  envName: 'ENV-Name',
};

/** Display form of a metadata value in a diff. */
export function diffValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '–';
  return String(v);
}

/** "m:ss" */
const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type Props = {
  request: AccessRequestDto;
  /** Current time (epoch ms); the parent ticks it once per second. */
  now: number;
  focused?: boolean;
  /** Decision in flight or done: the card plays its exit state. */
  leaving?: Decision | null;
  busy?: boolean;
  onDecide: (decision: Decision) => void;
  onFocus?: () => void;
};

/**
 * Signature element: one pending request as a sentence with the reason in italics,
 * delivery hint, optional metadata diff (update requests) and a draining time bar.
 */
export const RequestCard = forwardRef<HTMLElement, Props>(function RequestCard({ request: r, now, focused, leaving, busy, onDecide, onFocus }, ref) {
  const name = r.secret.envName ?? r.secret.title;
  const total = Math.max(1, Math.round((r.expiresAt - r.createdAt) / 1000));
  const left = Math.max(0, Math.min(total, Math.ceil((r.expiresAt - now) / 1000)));
  const pct = (left / total) * 100;
  const isUpdate = r.kind === 'update';
  const diff = Object.entries(r.metaDiff ?? {}) as [keyof RequestMetaDiff, { from: unknown; to: unknown }][];

  return (
    <article
      ref={ref}
      className={cx('req', focused && 'is-selected', leaving && 'is-leaving')}
      data-out={leaving ?? undefined}
      aria-label={`${isUpdate ? 'Änderungsanfrage' : 'Anfrage'} ${name}`}
      aria-current={focused ? 'true' : undefined}
      onClick={onFocus}
    >
      <div className="req-body">
        <div className="req-top">
          <span className="kind">
            <span className="dot dot-amber" aria-hidden />
            {isUpdate ? 'Änderung' : 'Abruf'}
          </span>
          <span title={formatAbsolute(r.createdAt)}>eingegangen {formatShortTime(r.createdAt)}</span>
          <span className="rid mono">{r.id}</span>
        </div>
        <p className="req-sentence">
          <span className="host">{r.device.name}</span> möchte <span className="secret">{name}</span>{' '}
          {isUpdate ? (
            'ändern.'
          ) : (
            <>
              für <span className="proj">{r.project}</span>.
            </>
          )}
        </p>
        <p className="req-reason">
          <span className="q">Grund:</span>
          {r.reason}
        </p>
        {isUpdate && (diff.length > 0 || r.valueChanged) ? (
          <dl className="req-diff">
            {diff.map(([field, d]) => (
              <DiffRow key={field} label={FIELD_LABELS[field]}>
                <del>{diffValue(d.from)}</del>
                <span className="arrow" aria-label="wird zu">
                  →
                </span>
                <ins>{diffValue(d.to)}</ins>
              </DiffRow>
            ))}
            {r.valueChanged ? (
              <DiffRow label="Wert">
                <span className="masked">••••••••</span>
                <span className="arrow" aria-hidden="true">
                  →
                </span>
                Wert wird geändert <span className="faint">(bisheriger Wert bleibt als Version erhalten)</span>
              </DiffRow>
            ) : null}
          </dl>
        ) : null}
        <div className="req-foot">
          <span className="req-via">
            {isUpdate ? (
              <>
                <FolderClosed className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                {r.project}
              </>
            ) : r.delivery === 'plaintext' ? (
              <>
                <FileText className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                Klartext an Agent
              </>
            ) : (
              <>
                <Terminal className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                via CLI-Übergabe
              </>
            )}
          </span>
          <div className="req-actions">
            <Button disabled={busy} onClick={() => onDecide('deny')}>
              Verweigern <Kbd aria-hidden>D</Kbd>
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => onDecide('approve')}>
              Freigeben <Kbd aria-hidden>A</Kbd>
            </Button>
          </div>
        </div>
      </div>
      <div className="timebar">
        <div className="track" role="progressbar" aria-label="Verbleibende Zeit" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left}>
          <div className="fill" style={{ width: `${Number(pct.toFixed(2))}%` }} />
        </div>
        <span className="left">
          läuft ab in <span className="num">{mss(left)}</span>
        </span>
      </div>
    </article>
  );
});

function DiffRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd aria-label={label}>{children}</dd>
    </>
  );
}
