import { FileText, FolderClosed, Terminal } from 'lucide-react';
import type { ApproveSummaryDto } from '@asm/shared';
import { t } from '../../i18n';
import { formatCountdown } from '../../lib/time';
import { diffValue, RenewalNote } from '../requests/RequestCard';

export const secretName = (s: ApproveSummaryDto) => s.secret.envName ?? s.secret.title;

/** "<device> wants <ENV|title> for <project>." / "<device> wants to change <ENV|title>." */
export function ApproveSentence({ summary: s }: { summary: ApproveSummaryDto }) {
  const host = <span className="host">{s.device.name}</span>;
  const secret = <span className="secret">{secretName(s)}</span>;
  return s.kind === 'update' ? t.requests.sentenceUpdate(host, secret) : t.requests.sentenceRead(host, secret, <span className="proj">{s.project}</span>);
}

/** Reason in italics, metadata diff for updates (never values) and the delivery hint. */
export function ApproveDetails({ summary: s, now = Date.now() }: { summary: ApproveSummaryDto; now?: number }) {
  const isUpdate = s.kind === 'update';
  const diff = Object.entries(s.metaDiff ?? {});
  return (
    <div className="consent-sec">
      <p className="req-reason">
        <span className="q">{t.requests.reason}</span>
        {s.reason}
      </p>
      {s.renewal ? <RenewalNote days={s.renewal.days} now={now} /> : null}
      {isUpdate && (diff.length > 0 || s.valueChanged) ? (
        <dl className="req-diff">
          {diff.map(([field, d]) => {
            const label = t.requests.fields[field] ?? field;
            if (d.redacted) {
              return (
                <DiffRow key={field} label={label}>
                  {t.approve.fieldChanges(label)}
                </DiffRow>
              );
            }
            return (
              <DiffRow key={field} label={label}>
                <del>{diffValue(d.from)}</del>
                <span className="arrow" aria-label={t.requests.becomes}>
                  →
                </span>
                <ins>{diffValue(d.to)}</ins>
              </DiffRow>
            );
          })}
          {s.valueChanged ? (
            <DiffRow label={t.requests.value}>
              <span className="masked" aria-hidden="true">
                ••••••••
              </span>
              <span className="arrow" aria-hidden="true">
                →
              </span>
              {t.requests.valueChanges}
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
            {t.requests.plaintextToAgent}
          </>
        ) : (
          <>
            <Terminal className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            {t.requests.viaCli}
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
      <div className="track" role="progressbar" aria-label={t.requests.timeLeft} aria-valuemin={0} aria-valuemax={total} aria-valuenow={left}>
        <div className="fill" style={{ width: `${Number(pct.toFixed(2))}%` }} />
      </div>
      <span className="left">
        {t.requests.expiresIn} <span className="num">{formatCountdown(left)}</span>
      </span>
    </div>
  );
}
