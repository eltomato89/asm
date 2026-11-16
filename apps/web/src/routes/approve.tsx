import { startAuthentication } from '@simplewebauthn/browser';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApproveDetails, ApproveSentence, ApproveTimeBar, secretName } from '../components/approve/ApproveDetails';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { api, isApiError, queryKeys } from '../lib/api';
import { decisionErrorText } from '../lib/errors';
import type { ApproveSummaryDto } from '../lib/push-types';
import { useNow } from '../lib/time';
import { PairingFrame, PairingResult } from './connect';

type Decision = 'approve' | 'deny';

/** Toast text for a failed decision on the public approve page. */
export function approveErrorText(e: unknown): string {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return 'Bestätigung abgebrochen. Nichts wurde freigegeben.';
  if (isApiError(e, 'verification_failed')) return 'Bestätigung fehlgeschlagen';
  if (isApiError(e, 'no_passkey')) return 'Für dein Konto ist kein Passkey hinterlegt – lege im Heimnetz unter Einstellungen einen an.';
  if (isApiError(e, 'forbidden')) return 'Dafür fehlen dir die Rechte.';
  if (isApiError(e, 'bad_origin')) return 'Diese Seite wurde über eine unerwartete Adresse geöffnet. Öffne den Link aus der Benachrichtigung erneut.';
  if (isApiError(e, 'invalid_request')) return 'Ungültige Anfrage. Lade die Seite neu und versuche es erneut.';
  if (isApiError(e, 'rate_limited')) return 'Zu viele Versuche. Warte eine Minute und versuche es erneut.';
  return decisionErrorText(e);
}

/** Codes after which the token is worthless: the page switches to the neutral "no longer valid" state. */
const FINAL_CODES = ['already_decided', 'expired', 'not_found', 'device_inactive'];

function Gone() {
  return (
    <PairingFrame note={false} className="approve">
      <div className="consent-result" role="status">
        <h2>Diese Anfrage ist nicht mehr gültig.</h2>
        <p>Sie wurde bereits entschieden oder ist abgelaufen. Du kannst dieses Fenster schließen.</p>
      </div>
    </PairingFrame>
  );
}

function Decided({ summary: s }: { summary: ApproveSummaryDto }) {
  const name = secretName(s);
  return (
    <PairingFrame note={false} className="approve">
      {s.status === 'approved' ? (
        <PairingResult ok title="Freigegeben">
          <p>
            <span className="host">{s.device.name}</span> {s.kind === 'update' ? `darf ${name} ändern.` : `erhält ${name}.`} Du kannst dieses Fenster schließen.
          </p>
        </PairingResult>
      ) : (
        <PairingResult ok={false} title="Verweigert">
          <p>
            <span className="host">{s.device.name}</span> erhält keinen Zugriff auf {name}. Du kannst dieses Fenster schließen.
          </p>
        </PairingResult>
      )}
    </PairingFrame>
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
      <PairingFrame note={false} className="approve">
        <div className="consent-result" role="status">
          <h2>Anfrage konnte nicht geladen werden</h2>
          <p>Prüfe die Verbindung und lade die Seite neu.</p>
          <p className="approve-result-actions">
            <Button onClick={() => window.location.reload()}>Neu laden</Button>
          </p>
        </div>
      </PairingFrame>
    );
  }

  if (summary.isPending) {
    return (
      <PairingFrame note={false} className="approve">
        <div className="consent-head" aria-busy="true" aria-label="Anfrage wird geladen">
          <Skeleton width="30%" style={{ margin: '0 auto 14px' }} />
          <Skeleton width="85%" height={24} style={{ margin: '0 auto' }} />
          <Skeleton width="55%" height={24} style={{ margin: '8px auto 0' }} />
        </div>
        <div className="consent-sec">
          <Skeleton width="70%" />
          <Skeleton width="40%" style={{ marginTop: 12 }} />
        </div>
        <div className="consent-actions">
          <Button disabled>Verweigern</Button>
          <Button variant="primary" disabled>
            Mit Face ID freigeben
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
          {s.kind === 'update' ? 'Änderung' : 'Abruf'}
        </p>
        <h1>
          <ApproveSentence summary={s} />
        </h1>
      </div>
      <ApproveDetails summary={s} />
      <ApproveTimeBar left={left} total={firstSeen.current} />
      <div className="consent-actions">
        <Button onClick={() => decide.mutate('deny')} disabled={busy}>
          Verweigern
        </Button>
        <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={busy}>
          Mit Face ID freigeben
        </Button>
      </div>
    </PairingFrame>
  );
}
