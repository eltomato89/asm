import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Inbox, KeyRound, Laptop, Pencil, Search, Terminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
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
          Du kannst die Verbindung jederzeit unter <Link to="/devices">Geräte</Link> widerrufen. Offene Übergaben verfallen dann sofort.
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
      <p className="rights-title">Dieses Gerät darf</p>
      <ul className="rights">
        <li>
          <span className="ri">
            <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>Secrets suchen</b>
            <span>Namen, Beschreibungen und Projekte, nie die Werte</span>
          </span>
        </li>
        <li>
          <span className="ri">
            <Inbox className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>Abrufe anfragen</b>
            <span>Jede Anfrage braucht deine Freigabe</span>
          </span>
        </li>
        <li>
          <span className="ri">
            <Pencil className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </span>
          <span>
            <b>Secrets anlegen, Änderungen vorschlagen, archivieren</b>
            <span>Änderungen an bestehenden Secrets gibst du einzeln frei</span>
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
        setError('Die Rückleitung zum Client ist ungültig. Starte die Kopplung im Client neu.');
        return;
      }
      setDone(decision);
      window.location.assign(redirectTo);
    },
    onError: (e) =>
      setError(
        isApiError(e, 'unknown_request')
          ? 'Diese Kopplungsanfrage ist inzwischen abgelaufen. Starte die Kopplung im Terminal neu.'
          : isApiError(e, 'reauth_required')
            ? 'Bestätigung abgebrochen. Es wurde nichts freigegeben.'
            : errorText(e, 'Das hat nicht geklappt. Versuche es erneut.'),
      ),
  });

  if (!req || info.isError) {
    const unknown = !req || isApiError(info.error, 'unknown_request') || isApiError(info.error, 'invalid_request');
    return (
      <PairingFrame note={false}>
        <PairingResult ok={false} title={unknown ? 'Kopplungsanfrage nicht gefunden' : 'Kopplung konnte nicht geladen werden'}>
          <p>
            {unknown
              ? 'Der Link ist abgelaufen oder unvollständig. Kopplungsanfragen gelten 10 Minuten. Starte die Kopplung im MCP-Client neu.'
              : 'Prüfe die Verbindung und lade die Seite neu.'}
          </p>
          <p style={{ marginTop: 16 }}>
            <Link className="btn" to="/">
              Zur Übersicht
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
          <PairingResult ok title="Verbunden">
            <p>
              <span className="host">{deviceName.trim() || info.data?.clientName}</span> ist jetzt gekoppelt. Du wirst zurück zum Client geleitet und kannst dieses Fenster danach schließen.
            </p>
          </PairingResult>
        ) : (
          <PairingResult ok={false} title="Verbindung verweigert">
            <p>{info.data?.clientName ?? 'Der Client'} hat keinen Zugriff erhalten. Starte die Kopplung neu, wenn das ein Versehen war.</p>
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
            <h1 id="c-title">{info.data.clientName} möchte sich mit ASM verbinden</h1>
            <p>
              auf <span className="mono">{window.location.host}</span>
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
        <label htmlFor="devname">Gerätename</label>
        <div className="input">
          <Laptop className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          <input id="devname" type="text" maxLength={100} spellCheck={false} autoComplete="off" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </div>
        <p className="help">So erscheint das Gerät in Anfragen und im Audit-Log.</p>
      </div>

      <Rights />

      <div className="consent-sec">
        <div className="redirect">
          Weiterleitung an <b>{info.data?.redirectHost ?? '…'}</b>
        </div>
      </div>

      {error ? (
        <p className="form-error consent-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="consent-actions">
        <Button onClick={() => decide.mutate('deny')} disabled={!info.data || decide.isPending}>
          Verweigern
        </Button>
        <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={!info.data || decide.isPending}>
          Freigeben
        </Button>
      </div>
    </PairingFrame>
  );
}
