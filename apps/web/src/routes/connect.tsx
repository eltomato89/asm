import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Inbox, KeyRound, Laptop, Pencil, Search, Terminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { t } from '../i18n';
import { ThemeMenu } from '../layout/Topbar';
import { api, isApiError } from '../lib/api';
import { errorText } from '../lib/errors';

/** Frame shared by the pairing pages: centered card, theme switch in the corner, revoke hint below. */
export function PairingFrame({ children, note = true, className }: { children: React.ReactNode; note?: boolean; className?: string }) {
  return (
    <main className="consent-page">
      <div className="consent-corner">
        <ThemeMenu />
      </div>
      <section className={className ? `consent ${className}` : 'consent'}>{children}</section>
      {note ? (
        <p className="consent-note">
          {t.connect.revokeNoteBefore}
          <Link to="/devices">{t.connect.revokeNoteLink}</Link>
          {t.connect.revokeNoteAfter}
        </p>
      ) : null}
    </main>
  );
}

export function PairMarks({ icon = 'terminal' }: { icon?: 'terminal' | 'laptop' }) {
  const Icon = icon === 'terminal' ? Terminal : Laptop;
  return (
    <div className="pair" aria-hidden="true">
      <span className="mark">
        <Icon className="icon" strokeWidth={1.5} />
      </span>
      <span className="link-line">
        <span className="ok">
          <Check className="icon" strokeWidth={2} />
        </span>
      </span>
      <span className="mark mark-asm">
        <KeyRound className="icon" strokeWidth={1.5} />
      </span>
    </div>
  );
}

export function Rights() {
  return (
    <div className="consent-sec">
      <p className="rights-title">{t.connect.rightsTitle}</p>
      <ul className="rights">
        <li>
          <span className="ri">
            <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>{t.connect.rights.search}</b>
            <span>{t.connect.rights.searchDetail}</span>
          </span>
        </li>
        <li>
          <span className="ri">
            <Inbox className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>{t.connect.rights.request}</b>
            <span>{t.connect.rights.requestDetail}</span>
          </span>
        </li>
        <li>
          <span className="ri">
            <Pencil className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>{t.connect.rights.write}</b>
            <span>{t.connect.rights.writeDetail}</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

export function PairingResult({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="consent-result" role="status">
      <h2>
        {ok ? (
          <Check className="icon" strokeWidth={2} style={{ color: 'var(--ok)' }} aria-hidden />
        ) : (
          <X className="icon" strokeWidth={2} style={{ color: 'var(--danger)' }} aria-hidden />
        )}
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Only follow http(s) redirects (never javascript:, data: or other schemes). */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** OAuth consent for MCP clients (`/connect?req=…`, opened by /oauth/authorize). */
export function ConnectPage({ req }: { req?: string }) {
  const info = useQuery({ queryKey: ['consent', req], queryFn: () => api.consentInfo(req!), enabled: !!req, retry: false, staleTime: Infinity });
  const [deviceName, setDeviceName] = useState('');
  const [done, setDone] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (info.data) setDeviceName((n) => n || info.data.clientName);
  }, [info.data]);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      api.consent({ req: req!, decision, ...(decision === 'approve' && deviceName.trim() ? { deviceName: deviceName.trim() } : {}) }),
    onSuccess: ({ redirectTo }, decision) => {
      if (!isHttpUrl(redirectTo)) {
        setError(t.connect.mcp.invalidRedirect);
        return;
      }
      setDone(decision);
      window.location.assign(redirectTo);
    },
    onError: (e) =>
      setError(
        isApiError(e, 'unknown_request')
          ? t.connect.mcp.expired
          : isApiError(e, 'reauth_required')
            ? t.connect.reauthCancelled
            : errorText(e, t.connect.failed),
      ),
  });

  if (!req || info.isError) {
    const unknown = !req || isApiError(info.error, 'unknown_request') || isApiError(info.error, 'invalid_request');
    return (
      <PairingFrame note={false}>
        <PairingResult ok={false} title={unknown ? t.connect.mcp.notFound : t.connect.mcp.loadFailed}>
          <p>
            {unknown
              ? t.connect.mcp.notFoundText
              : t.connect.mcp.loadFailedText}
          </p>
          <p style={{ marginTop: 16 }}>
            <Link className="btn" to="/">
              {t.connect.mcp.toOverview}
            </Link>
          </p>
        </PairingResult>
      </PairingFrame>
    );
  }

  if (done) {
    return (
      <PairingFrame>
        {done === 'approve' ? (
          <PairingResult ok title={t.connect.connected}>
            <p>
              <span className="host">{deviceName.trim() || info.data?.clientName}</span>
              {t.connect.mcp.pairedRedirect}
            </p>
          </PairingResult>
        ) : (
          <PairingResult ok={false} title={t.connect.mcp.denied}>
            <p>{t.connect.mcp.deniedText(info.data?.clientName ?? t.connect.mcp.theClient)}</p>
          </PairingResult>
        )}
      </PairingFrame>
    );
  }

  return (
    <PairingFrame>
      <div className="consent-head">
        <PairMarks />
        {info.data ? (
          <>
            <h1 id="c-title">{t.connect.wantsToConnect(info.data.clientName)}</h1>
            <p>
              {t.connect.onHostBefore}
              <span className="mono">{window.location.host}</span>
            </p>
          </>
        ) : (
          <>
            <Skeleton width="80%" height={24} style={{ margin: '0 auto' }} />
            <Skeleton width="40%" style={{ margin: '12px auto 0' }} />
          </>
        )}
      </div>

      <div className="consent-sec field">
        <label htmlFor="devname">{t.connect.mcp.deviceName}</label>
        <div className="input">
          <Laptop className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          <input id="devname" type="text" maxLength={100} spellCheck={false} autoComplete="off" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </div>
        <p className="help">{t.connect.mcp.deviceNameHelp}</p>
      </div>

      <Rights />

      <div className="consent-sec">
        <div className="redirect">
          {t.connect.mcp.redirectTo}
          <b>{info.data?.redirectHost ?? '…'}</b>
        </div>
      </div>

      {error ? (
        <p className="form-error consent-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="consent-actions">
        <Button onClick={() => decide.mutate('deny')} disabled={!info.data || decide.isPending}>
          {t.connect.deny}
        </Button>
        <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={!info.data || decide.isPending}>
          {t.connect.approve}
        </Button>
      </div>
    </PairingFrame>
  );
}
