import { Copy, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

export const REVEAL_TTL_MS = 30_000;

type Props = {
  /** Fetches the plaintext (explicit click only; may open the ReauthDialog). */
  reveal: () => Promise<{ value: string }>;
  label?: string;
  compact?: boolean;
};

/**
 * Masked secret value with „Anzeigen“ / „Kopieren“. The plaintext is fetched on demand, kept only in this
 * component's state (never in a query/mutation cache, URL or log), hidden again after 30 s and dropped on unmount.
 */
export function SecretValue({ reveal, label = 'Wert', compact }: Props) {
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const forget = () => {
    clearTimeout(timer.current);
    setValue(null);
    setShown(false);
  };

  const load = async (): Promise<string | null> => {
    if (value !== null) return value;
    setBusy(true);
    try {
      const res = await reveal();
      if (!alive.current) return null;
      setValue(res.value);
      clearTimeout(timer.current);
      timer.current = setTimeout(forget, REVEAL_TTL_MS);
      return res.value;
    } catch (e) {
      if (alive.current) toast(isApiError(e, 'reauth_required') ? 'Bestätigung abgebrochen. Der Wert bleibt verborgen.' : errorText(e, 'Der Wert konnte nicht geladen werden.'), 'danger');
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const toggle = async () => {
    if (shown) return forget();
    if ((await load()) !== null) setShown(true);
  };

  const copy = async () => {
    const v = await load();
    if (v === null) return;
    try {
      await navigator.clipboard.writeText(v);
      toast('Kopiert', 'ok');
    } catch {
      toast('Kopieren nicht möglich. Zeige den Wert an und kopiere ihn manuell.', 'danger');
    }
  };

  return (
    <div className={compact ? 'secret-value is-compact' : 'secret-value'}>
      <code className="sv-text" aria-label={label} aria-live="polite">
        {shown && value !== null ? value : '••••••••••••'}
      </code>
      <div className="sv-actions">
        <Button variant="ghost" onClick={() => void toggle()} disabled={busy} aria-pressed={shown}>
          {shown ? <EyeOff className="icon icon-sm" strokeWidth={1.5} aria-hidden /> : <Eye className="icon icon-sm" strokeWidth={1.5} aria-hidden />}
          {shown ? 'Verbergen' : 'Anzeigen'}
        </Button>
        <Button variant="ghost" onClick={() => void copy()} disabled={busy}>
          <Copy className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          Kopieren
        </Button>
      </div>
    </div>
  );
}
