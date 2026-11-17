import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Field';
import { t } from '../i18n';
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
  if (isApiError(e, 'invalid_code')) return t.connect.cli.invalidCode;
  if (isApiError(e, 'reauth_required')) return t.connect.reauthCancelled;
  return errorText(e, t.connect.failed);
}

/** CLI pairing (device authorization grant): enter the code shown by `asm login`, check the device, decide. */
export function ActivatePage({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(() => formatUserCode(initialCode ?? ''));
  const [preview, setPreview] = useState<ActivationInfo | null>(null);
  /** Main device to attach the new CLI to; '' = don't link. */
  const [linkTo, setLinkTo] = useState('');
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: () => api.activationInfo(code),
    onSuccess: (info) => {
      setPreview(info);
      setLinkTo(info.suggestedLinkId ?? '');
      setError(null);
    },
    onError: (e) => setError(codeError(e)),
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      api.activate({ user_code: code, decision, ...(decision === 'approve' && linkTo ? { link_to_device_id: linkTo } : {}) }),
    onSuccess: (r) => setResult(r.status),
    onError: (e) => setError(codeError(e)),
  });

  const complete = code.length === 9;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete) lookup.mutate();
  };

  const candidates = preview?.linkCandidates ?? [];
  const linkedName = candidates.find((c) => c.id === linkTo)?.name;

  if (result) {
    return (
      <PairingFrame note={result === 'approved'}>
        {result === 'approved' ? (
          <PairingResult ok title={t.connect.connected}>
            <p>
              <span className="host">{preview?.name}</span>
              {linkedName ? t.connect.cli.pairedLinked(linkedName) : t.connect.cli.paired}
            </p>
            <p style={{ marginTop: 16 }}>
              <Link className="btn" to="/devices">
                {t.connect.cli.toDevices}
              </Link>
            </p>
          </PairingResult>
        ) : (
          <PairingResult ok={false} title={t.connect.cli.denied}>
            <p>{t.connect.cli.deniedText}</p>
          </PairingResult>
        )}
      </PairingFrame>
    );
  }

  return (
    <PairingFrame note={false}>
      <div className="consent-head">
        <PairMarks />
        <h1>{preview ? t.connect.wantsToConnect(preview.name) : t.connect.cli.title}</h1>
        <p>
          {preview ? (
            t.connect.cli.checkStarted
          ) : (
            <>
              {t.connect.cli.enterCodeBefore}
              <span className="mono">asm login</span>
              {t.connect.cli.enterCodeAfter}
            </>
          )}
        </p>
      </div>

      <form className="consent-sec field" onSubmit={submit}>
        <label htmlFor="user-code">{t.connect.cli.code}</label>
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
            {t.connect.cli.continue}
          </Button>
        ) : null}
      </form>

      {preview ? (
        <>
          <div className="consent-sec">
            <dl className="kv">
              <dt>{t.connect.cli.device}</dt>
              <dd className="host">{preview.name}</dd>
              <dt>{t.connect.cli.host}</dt>
              <dd>{preview.hostname ? <span className="host">{preview.hostname}</span> : <span className="faint">–</span>}</dd>
              <dt>{t.connect.cli.requested}</dt>
              <dd className="num" title={formatAbsolute(preview.requestedAt)}>
                {t.connect.cli.requestedAt(formatShortTime(preview.requestedAt))}
              </dd>
            </dl>
          </div>
          {candidates.length > 0 ? (
            <div className="consent-sec">
              <Select label={t.connect.cli.linkLabel} help={t.connect.cli.linkHelp} value={linkTo} disabled={decide.isPending} onChange={(e) => setLinkTo(e.target.value)}>
                <option value="">{t.connect.cli.linkNone}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
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
            {t.connect.deny}
          </Button>
          <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
            {t.connect.approve}
          </Button>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}
    </PairingFrame>
  );
}
