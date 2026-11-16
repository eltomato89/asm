import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { api, isApiError, type ActivationInfo } from '../lib/api';
import { errorText } from '../lib/errors';
import { formatAbsolute, formatShortTime } from '../lib/format';
import { PairingFrame, PairingResult, PairMarks, Rights } from './connect';

/** "bcdf ghjk" / "BCDFGHJK" → "BCDF-GHJK" while typing (letters only, max 8). */
export function formatUserCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

function codeError(e: unknown): string {
  if (isApiError(e, 'invalid_code')) return 'Dieser Code ist ungültig oder abgelaufen. Starte die Kopplung im Terminal neu.';
  if (isApiError(e, 'reauth_required')) return 'Bestätigung abgebrochen. Es wurde nichts freigegeben.';
  return errorText(e, 'Das hat nicht geklappt. Versuche es erneut.');
}

/** CLI pairing (device authorization grant): enter the code shown by `asm login`, check the device, decide. */
export function ActivatePage({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(() => formatUserCode(initialCode ?? ''));
  const [preview, setPreview] = useState<ActivationInfo | null>(null);
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: () => api.activationInfo(code),
    onSuccess: (info) => {
      setPreview(info);
      setError(null);
    },
    onError: (e) => setError(codeError(e)),
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') => api.activate({ user_code: code, decision }),
    onSuccess: (r) => setResult(r.status),
    onError: (e) => setError(codeError(e)),
  });

  const complete = code.length === 9;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete) lookup.mutate();
  };

  if (result) {
    return (
      <PairingFrame note={result === 'approved'}>
        {result === 'approved' ? (
          <PairingResult ok title="Verbunden">
            <p>
              <span className="host">{preview?.name}</span> ist jetzt gekoppelt. Das Terminal meldet sich in wenigen Sekunden von selbst.
            </p>
            <p style={{ marginTop: 16 }}>
              <Link className="btn" to="/devices">
                Zu den Geräten
              </Link>
            </p>
          </PairingResult>
        ) : (
          <PairingResult ok={false} title="Kopplung verweigert">
            <p>Das Gerät hat keinen Zugriff erhalten.</p>
          </PairingResult>
        )}
      </PairingFrame>
    );
  }

  return (
    <PairingFrame note={false}>
      <div className="consent-head">
        <PairMarks />
        <h1>{preview ? `${preview.name} möchte sich mit ASM verbinden` : 'Gerät koppeln'}</h1>
        <p>{preview ? <>Prüfe, ob du die Kopplung gerade selbst gestartet hast.</> : <>Gib den Code ein, den <span className="mono">asm login</span> im Terminal anzeigt.</>}</p>
      </div>

      <form className="consent-sec field" onSubmit={submit}>
        <label htmlFor="user-code">Code</label>
        <div className="input">
          <input
            id="user-code"
            className="code-input"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            maxLength={9}
            value={code}
            disabled={!!preview}
            onChange={(e) => {
              setCode(formatUserCode(e.target.value));
              setError(null);
            }}
          />
        </div>
        {!preview ? (
          <Button type="submit" variant="primary" size="lg" block disabled={!complete || lookup.isPending} style={{ marginTop: 12 }}>
            Weiter
          </Button>
        ) : null}
      </form>

      {preview ? (
        <>
          <div className="consent-sec">
            <dl className="kv">
              <dt>Gerät</dt>
              <dd className="host">{preview.name}</dd>
              <dt>Host</dt>
              <dd>{preview.hostname ? <span className="host">{preview.hostname}</span> : <span className="faint">–</span>}</dd>
              <dt>Angefragt</dt>
              <dd className="num" title={formatAbsolute(preview.requestedAt)}>
                {formatShortTime(preview.requestedAt)} Uhr
              </dd>
            </dl>
          </div>
          <Rights />
        </>
      ) : null}

      {error ? (
        <p className="form-error consent-error" role="alert">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="consent-actions">
          <Button onClick={() => decide.mutate('deny')} disabled={decide.isPending}>
            Verweigern
          </Button>
          <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
            Freigeben
          </Button>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}
    </PairingFrame>
  );
}
