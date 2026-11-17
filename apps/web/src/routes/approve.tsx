import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { ApproveDetails, ApproveSentence, ApproveTimeBar, secretName } from '../components/approve/ApproveDetails';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { t } from '../i18n';
import { api, isApiError, queryKeys } from '../lib/api';
import { decisionErrorText } from '../lib/errors';
import { isIOS } from '../lib/push';
import type { ApproveSummaryDto } from '@asm/shared';
import { useNow } from '../lib/time';
import { PairingFrame } from './connect';

type Decision = 'approve' | 'deny';

/** Toast text for a failed decision on the public approve page. */
export function approveErrorText(e: unknown): string {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return t.approve.cancelled;
  if (isApiError(e, 'verification_failed')) return t.approve.verificationFailed;
  if (isApiError(e, 'no_passkey')) return t.approve.noPasskey;
  if (isApiError(e, 'forbidden')) return t.errors.forbidden;
  if (isApiError(e, 'bad_origin')) return t.approve.badOrigin;
  if (isApiError(e, 'invalid_request')) return t.approve.invalidRequest;
  if (isApiError(e, 'rate_limited')) return t.errors.rateLimited;
  return decisionErrorText(e);
}

/** Codes after which the token is worthless: the page switches to the neutral "no longer valid" state. */
const FINAL_CODES = ['already_decided', 'expired', 'not_found', 'device_inactive'];

/** Face ID on iPhone/iPad, a generic passkey everywhere else. */
const approveLabel = () => (isIOS() ? t.approve.withFaceId : t.approve.withPasskey);

/** Way back into the app after a decision; in the installed web app there is no window to close. */
function OpenAppLink() {
  return (
    <p className="approve-result-actions">
      <Link to="/" className="btn btn-primary">
        {t.approve.openApp}
      </Link>
    </p>
  );
}

/** Final/neutral states share one frame with the page title as h1 (like the open request). */
function ApproveResult({ icon, title, children }: { icon?: 'ok' | 'no'; title: string; children: React.ReactNode }) {
  return (
    <PairingFrame note={false} className="approve">
      <div className="consent-result" role="status">
        <h1>
          {icon === 'ok' ? <Check className="icon" strokeWidth={2} style={{ color: 'var(--ok)' }} aria-hidden /> : null}
          {icon === 'no' ? <X className="icon" strokeWidth={2} style={{ color: 'var(--danger)' }} aria-hidden /> : null}
          {title}
        </h1>
        {children}
      </div>
    </PairingFrame>
  );
}

function Gone() {
  return (
    <ApproveResult title={t.approve.goneTitle}>
      <p>{t.approve.goneBody}</p>
      <OpenAppLink />
    </ApproveResult>
  );
}

function Decided({ summary: s }: { summary: ApproveSummaryDto }) {
  const name = secretName(s);
  return s.status === 'approved' ? (
    <ApproveResult icon="ok" title={t.approve.approvedTitle}>
      <p>
        <span className="host">{s.device.name}</span> {s.kind === 'update' ? t.approve.mayChange(name) : t.approve.receives(name)}
      </p>
      <OpenAppLink />
    </ApproveResult>
  ) : (
    <ApproveResult icon="no" title={t.approve.deniedTitle}>
      <p>
        <span className="host">{s.device.name}</span> {t.approve.noAccess(name)}
      </p>
      <OpenAppLink />
    </ApproveResult>
  );
}

/**
 * Public approve page (`/approve/:token`, opened from a push notification): no app shell, no session.
 * The token is the only credential; approving additionally needs a passkey with user verification.
 */
export function ApprovePage({ token }: { token: string }) {
  const toast = useToast();
  const summary = useQuery({
    queryKey: queryKeys.approve(token),
    queryFn: () => api.approveSummary(token),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [result, setResult] = useState<ApproveSummaryDto | null>(null);
  const [gone, setGone] = useState(false);
  const now = useNow(1000, summary.isSuccess && !result && !gone);
  // Total of the time bar: the time left when the page first showed the request.
  const firstSeen = useRef<number | null>(null);

  const decide = useMutation({
    mutationFn: async (decision: Decision) => {
      if (decision === 'deny') return api.approveDecision(token, { decision });
      const optionsJSON = await api.approveOptions(token);
      const response = await startAuthentication({ optionsJSON });
      return api.approveDecision(token, { decision, response });
    },
    onSuccess: (dto) => setResult(dto),
    onError: (e) => {
      toast(approveErrorText(e), 'danger');
      if (FINAL_CODES.some((c) => isApiError(e, c))) setGone(true);
    },
  });

  if (gone) return <Gone />;
  if (result && result.status !== 'pending') return result.status === 'expired' ? <Gone /> : <Decided summary={result} />;

  if (summary.isError) {
    if (isApiError(summary.error) && (summary.error.status === 404 || summary.error.status === 410)) return <Gone />;
    return (
      <ApproveResult title={t.approve.loadFailedTitle}>
        <p>{t.approve.loadFailedBody}</p>
        <p className="approve-result-actions">
          <Button onClick={() => window.location.reload()}>{t.common.reload}</Button>
        </p>
      </ApproveResult>
    );
  }

  if (summary.isPending) {
    return (
      <PairingFrame note={false} className="approve">
        <div className="consent-head" aria-busy="true" aria-label={t.approve.loading}>
          <Skeleton width="30%" style={{ margin: '0 auto 14px' }} />
          <Skeleton width="85%" height={24} style={{ margin: '0 auto' }} />
          <Skeleton width="55%" height={24} style={{ margin: '8px auto 0' }} />
        </div>
        <div className="consent-sec">
          <Skeleton width="70%" />
          <Skeleton width="40%" style={{ marginTop: 12 }} />
        </div>
        <div className="consent-actions">
          <Button disabled>{t.requests.deny}</Button>
          <Button variant="primary" disabled>
            {approveLabel()}
          </Button>
        </div>
      </PairingFrame>
    );
  }

  const s = summary.data;
  if (s.status === 'approved' || s.status === 'denied') return <Decided summary={s} />;
  const left = Math.max(0, Math.ceil((s.expiresAt - now) / 1000));
  if (s.status === 'expired' || left === 0) return <Gone />;
  firstSeen.current ??= left;
  const busy = decide.isPending;

  return (
    <PairingFrame note={false} className="approve">
      <div className="consent-head">
        <p className="approve-kind">
          <span className="dot dot-amber" aria-hidden />
          {s.kind === 'update' ? t.requests.kindUpdate : t.requests.kindRead}
        </p>
        <h1>
          <ApproveSentence summary={s} />
        </h1>
        {s.secret.envName && s.secret.title && s.secret.title !== s.secret.envName ? <p className="approve-title">{s.secret.title}</p> : null}
      </div>
      <ApproveDetails summary={s} now={now} />
      <ApproveTimeBar left={left} total={firstSeen.current} />
      <div className="consent-actions">
        <Button onClick={() => decide.mutate('deny')} disabled={busy}>
          {t.requests.deny}
        </Button>
        <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={busy}>
          {approveLabel()}
        </Button>
      </div>
    </PairingFrame>
  );
}
