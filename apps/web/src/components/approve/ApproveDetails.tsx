import { FileText, FolderClosed, Terminal } from 'lucide-react';
import type { ApproveSummaryDto } from '@asm/shared';
import { formatCountdown } from '../../lib/time';
import { diffValue } from '../requests/RequestCard';

const FIELD_LABELS: Record<string, string> = {
  title: 'Titel',
  description: 'Beschreibung',
  tags: 'Tags',
  envName: 'ENV-Name',
};

export const secretName = (s: ApproveSummaryDto) => s.secret.envName ?? s.secret.title;

/** "<device> möchte <ENV|Titel> für <project>." / "… ändern." */
export function ApproveSentence({ summary: s }: { summary: ApproveSummaryDto }) {
  return (
    <>
      <span className="host">{s.device.name}</span> möchte <span className="secret">{secretName(s)}</span>{' '}
      {s.kind === 'update' ? (
        'ändern.'
      ) : (
        <>
          für <span className="proj">{s.project}</span>.
        </>
      )}
    </>
  );
}

/** Reason in italics, metadata diff for updates (never values) and the delivery hint. */
export function ApproveDetails({ summary: s }: { summary: ApproveSummaryDto }) {
  const isUpdate = s.kind === 'update';
  const diff = Object.entries(s.metaDiff ?? {});
  return (
    <div className="consent-sec">
      <p className="req-reason">
        <span className="q">Grund:</span>
        {s.reason}
      </p>
      {isUpdate && (diff.length > 0 || s.valueChanged) ? (
        <dl className="req-diff">
          {diff.map(([field, d]) => {
            const label = FIELD_LABELS[field] ?? field;
            if (d.redacted) {
              return (
                <DiffRow key={field} label={label}>
                  {label} wird geändert
                </DiffRow>
              );
            }
            return (
              <DiffRow key={field} label={label}>
                <del>{diffValue(d.from)}</del>
                <span className="arrow" aria-label="wird zu">
                  →
                </span>
                <ins>{diffValue(d.to)}</ins>
              </DiffRow>
            );
          })}
          {s.valueChanged ? (
            <DiffRow label="Wert">
              <span className="masked" aria-hidden="true">
                ••••••••
              </span>
              <span className="arrow" aria-hidden="true">
                →
              </span>
              Wert wird geändert
            </DiffRow>
          ) : null}
        </dl>
      ) : null}
      <p className="req-via">
        {isUpdate ? (
          <>
            <FolderClosed className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            {s.project}
          </>
        ) : s.delivery === 'plaintext' ? (
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
      </p>
    </div>
  );
}

function DiffRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd aria-label={label}>{children}</dd>
    </>
  );
}

/** Draining amber bar from the moment the page was opened (`total` seconds) to the expiry. */
export function ApproveTimeBar({ left, total }: { left: number; total: number }) {
  const pct = total > 0 ? (Math.min(left, total) / total) * 100 : 0;
  return (
    <div className="timebar">
      <div className="track" role="progressbar" aria-label="Verbleibende Zeit" aria-valuemin={0} aria-valuemax={total} aria-valuenow={left}>
        <div className="fill" style={{ width: `${Number(pct.toFixed(2))}%` }} />
      </div>
      <span className="left">
        läuft ab in <span className="num">{formatCountdown(left)}</span>
      </span>
    </div>
  );
}
