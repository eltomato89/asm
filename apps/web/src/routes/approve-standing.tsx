import type { StandingApproveSummaryDto, StandingNarrowInput } from '@asm/shared';
import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ShieldCheck, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ApproveTimeBar } from '../components/approve/ApproveDetails';
import { AttachedCliNote } from '../components/requests/StandingRequestCard';
import { initialNarrowing, isValidNarrowing, ProposalForm } from '../components/standing/ProposalForm';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { t } from '../i18n';
import { api, isApiError, queryKeys } from '../lib/api';
import { standingDecisionErrorText } from '../lib/errors';
import { isIOS } from '../lib/push';
import { useNow } from '../lib/time';
import { approveErrorText } from './approve';
import { PairingFrame } from './connect';

type Decision = 'approve' | 'deny';

/** Codes that only exist for proposals come first; passkey/transport errors as on the ordinary approve page. */
export function approveStandingErrorText(e: unknown): string {
  for (const code of ['not_narrower', 'invalid_days', 'standing_active', 'standing_requests_disabled']) {
    if (isApiError(e, code)) return standingDecisionErrorText(e);
  }
  return approveErrorText(e);
}

/** Codes after which the token is worthless: the page switches to the neutral "no longer valid" state. */
const FINAL_CODES = ['already_decided', 'expired', 'not_found', 'device_inactive', 'standing_active', 'standing_requests_disabled'];

const approveLabel = () => (isIOS() ? t.approve.withFaceId : t.approve.withPasskey);

function Result({ icon, title, children }: { icon?: 'ok' | 'no'; title: string; children: React.ReactNode }) {
  return (
    <PairingFrame note={false} className="approve">
      <div className="consent-result" role="status">
        <h1>
          {icon === 'ok' ? <Check className="icon" strokeWidth={2} style={{ color: 'var(--ok)' }} aria-hidden /> : null}
          {icon === 'no' ? <X className="icon" strokeWidth={2} style={{ color: 'var(--danger)' }} aria-hidden /> : null}
          {title}
        </h1>
        {children}
        <p className="approve-result-actions">
          <Link to="/" className="btn btn-primary">
            {t.approve.openApp}
          </Link>
        </p>
      </div>
    </PairingFrame>
  );
}

const Gone = () => (
  <Result title={t.approve.goneTitle}>
    <p>{t.approve.goneBody}</p>
  </Result>
);

function Decided({ summary: s }: { summary: StandingApproveSummaryDto }) {
  const host = <span className="host">{s.device.name}</span>;
  return s.status === 'approved' ? (
    <Result icon="ok" title={t.approve.approvedTitle}>
      <p>
        {host} {t.standingRequest.page.approvedBody((s.final ?? s.proposal).days)}
      </p>
    </Result>
  ) : (
    <Result icon="no" title={t.approve.deniedTitle}>
      <p>
        {host} {t.standingRequest.page.deniedBody}
      </p>
    </Result>
  );
}

/**
 * Public approve page for an agent's proposed standing approval (`/approve/standing/:token`, from a push
 * notification). No session: the token is the credential; approving needs a passkey with user verification.
 * The proposal can only be narrowed here, like on the request card.
 */
export function ApproveStandingPage({ token }: { token: string }) {
  const summary = useQuery({
    queryKey: queryKeys.approveStanding(token),
    queryFn: () => api.standingApproveSummary(token),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (summary.isError) {
    if (isApiError(summary.error) && (summary.error.status === 404 || summary.error.status === 410)) return <Gone />;
    return (
      <Result title={t.approve.loadFailedTitle}>
        <p>{t.approve.loadFailedBody}</p>
        <p className="approve-result-actions">
          <Button onClick={() => window.location.reload()}>{t.common.reload}</Button>
        </p>
      </Result>
    );
  }
  if (summary.isPending) {
    return (
      <PairingFrame note={false} className="approve">
        <div className="consent-head" aria-busy="true" aria-label={t.standingRequest.page.loading}>
          <Skeleton width="30%" style={{ margin: '0 auto 14px' }} />
          <Skeleton width="85%" height={24} style={{ margin: '0 auto' }} />
        </div>
        <div className="consent-sec">
          <Skeleton width="70%" />
          <Skeleton width="40%" style={{ marginTop: 12 }} />
        </div>
        <div className="consent-actions">
          <Button disabled>{t.standingRequest.deny}</Button>
          <Button variant="primary" disabled>
            {approveLabel()}
          </Button>
        </div>
      </PairingFrame>
    );
  }
  return <Pending token={token} summary={summary.data} />;
}

function Pending({ token, summary: s }: { token: string; summary: StandingApproveSummaryDto }) {
  const toast = useToast();
  const [result, setResult] = useState<StandingApproveSummaryDto | null>(null);
  const [gone, setGone] = useState(false);
  const [settings, setSettings] = useState<StandingNarrowInput>(() => initialNarrowing(s.proposal, s.items, s.limits));
  const [valid, setValid] = useState(() => isValidNarrowing(s.proposal, settings, s.limits));
  const now = useNow(1000, s.status === 'pending' && !result && !gone);
  const firstSeen = useRef<number | null>(null);

  const decide = useMutation({
    mutationFn: async (decision: Decision) => {
      if (decision === 'deny') return api.standingApproveDecision(token, { decision });
      const optionsJSON = await api.standingApproveOptions(token);
      const response = await startAuthentication({ optionsJSON });
      return api.standingApproveDecision(token, { decision, response, settings });
    },
    onSuccess: (dto) => setResult(dto),
    onError: (e) => {
      toast(approveStandingErrorText(e), 'danger');
      if (FINAL_CODES.some((c) => isApiError(e, c))) setGone(true);
    },
  });

  if (gone) return <Gone />;
  const current = result ?? s;
  if (current.status === 'approved' || current.status === 'denied') return <Decided summary={current} />;
  if (current.status !== 'pending') return <Gone />;
  const left = Math.max(0, Math.ceil((s.expiresAt - now) / 1000));
  if (left === 0) return <Gone />;
  firstSeen.current ??= left;
  const busy = decide.isPending;

  return (
    <PairingFrame note={false} className="approve approve-standing">
      <div className="consent-head">
        <p className="approve-kind">
          <ShieldCheck className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          {t.standingRequest.kind}
        </p>
        <h1>{t.standingRequest.sentence(<span className="host">{s.device.name}</span>, s.project ? <span className="proj">{s.project}</span> : null)}</h1>
      </div>
      <div className="consent-sec">
        <p className="req-reason">
          <span className="q">{t.requests.reason}</span>
          {s.reason}
        </p>
        <AttachedCliNote cli={s.attachedCli} />
      </div>
      <div className="consent-sec">
        <ProposalForm
          proposal={s.proposal}
          items={s.items}
          limits={s.limits}
          value={settings}
          disabled={busy}
          onChange={(next, ok) => {
            setSettings(next);
            setValid(ok);
          }}
        />
        <p className="standing-req-note">{t.standingRequest.readsOnly}</p>
      </div>
      <ApproveTimeBar left={left} total={firstSeen.current} />
      <div className="consent-actions">
        <Button onClick={() => decide.mutate('deny')} disabled={busy}>
          {t.standingRequest.deny}
        </Button>
        <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={busy || !valid}>
          {approveLabel()}
        </Button>
      </div>
    </PairingFrame>
  );
}
