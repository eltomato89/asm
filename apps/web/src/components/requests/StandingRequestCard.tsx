import type { StandingNarrowInput, StandingRequestDto } from '@asm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Terminal } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';
import { cx } from '../../lib/cx';
import { standingDecisionErrorText } from '../../lib/errors';
import { formatAbsolute, formatShortTime } from '../../lib/format';
import { ApproveTimeBar } from '../approve/ApproveDetails';
import { initialNarrowing, isValidNarrowing, ProposalForm } from '../standing/ProposalForm';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

type Decision = 'approve' | 'deny';

/** "asm on mbp-office, ci-runner" for the CLIs attached to the proposing device. */
export const attachedHosts = (cli: StandingRequestDto['attachedCli']) => cli.map((c) => c.hostname ?? c.name).join(', ');

/** Note line under the sentence: the approval covers the attached CLIs too. */
export function AttachedCliNote({ cli }: { cli: StandingRequestDto['attachedCli'] }) {
  if (cli.length === 0) return null;
  return (
    <p className="req-via standing-req-attached">
      <Terminal className="icon icon-sm" strokeWidth={1.5} aria-hidden />
      {t.standingRequest.alsoApplies(attachedHosts(cli))}
    </p>
  );
}

/**
 * An agent's proposal for a standing approval: amber card with a shield, the narrow-only form and
 * Deny/Approve of equal weight. Deliberately no keyboard shortcuts; approving asks for a recent sign-in.
 */
export function StandingRequestCard({ request: r, now }: { request: StandingRequestDto; now: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [settings, setSettings] = useState<StandingNarrowInput>(() => initialNarrowing(r.proposal, r.items, r.limits));
  const [valid, setValid] = useState(() => isValidNarrowing(r.proposal, settings, r.limits));
  const [leaving, setLeaving] = useState<Decision | null>(null);

  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      api.decideStandingRequest(r.id, decision === 'approve' ? { decision, settings } : { decision }),
    onMutate: (decision) => setLeaving(decision),
    onSuccess: (_dto, decision) => {
      toast(decision === 'approve' ? t.standingRequest.toastApproved(r.device.name) : t.standingRequest.toastDenied(r.device.name), decision === 'approve' ? 'ok' : 'danger');
    },
    onError: (e) => {
      setLeaving(null);
      toast(standingDecisionErrorText(e), 'danger');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.standingRequestsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.devices });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });

  const total = Math.max(1, Math.round((r.expiresAt - r.createdAt) / 1000));
  const left = Math.max(0, Math.min(total, Math.ceil((r.expiresAt - now) / 1000)));
  const busy = decide.isPending || leaving !== null;

  return (
    <article
      className={cx('req req-standing', leaving && 'is-leaving')}
      data-out={leaving ?? undefined}
      aria-label={t.standingRequest.cardLabel(r.device.name)}
    >
      <div className="req-body">
        <div className="req-top">
          <span className="kind">
            <ShieldCheck className="icon icon-sm" strokeWidth={1.5} aria-hidden />
            {t.standingRequest.kind}
          </span>
          <span title={formatAbsolute(r.createdAt)}>{t.requests.received(formatShortTime(r.createdAt))}</span>
          <span className="rid mono">{r.id}</span>
        </div>
        <p className="req-sentence">{t.standingRequest.sentence(<span className="host">{r.device.name}</span>, r.project ? <span className="proj">{r.project}</span> : null)}</p>
        <p className="req-reason">
          <span className="q">{t.requests.reason}</span>
          {r.reason}
        </p>
        <AttachedCliNote cli={r.attachedCli} />
        <ProposalForm
          proposal={r.proposal}
          items={r.items}
          limits={r.limits}
          value={settings}
          disabled={busy}
          onChange={(next, ok) => {
            setSettings(next);
            setValid(ok);
          }}
        />
        <p className="standing-req-note">{t.standingRequest.readsOnly}</p>
        <div className="req-foot">
          <div className="req-actions standing-req-actions">
            <Button className="standing-req-btn" disabled={busy} onClick={() => decide.mutate('deny')}>
              {t.standingRequest.deny}
            </Button>
            <Button className="standing-req-btn" variant="primary" disabled={busy || !valid} onClick={() => decide.mutate('approve')}>
              {t.standingRequest.approve}
            </Button>
          </div>
        </div>
      </div>
      <ApproveTimeBar left={left} total={total} />
    </article>
  );
}
