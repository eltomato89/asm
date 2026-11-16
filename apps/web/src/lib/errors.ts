import { isApiError } from './api';

const CAUSES: Record<string, string> = {
  stale: 'Secret wurde inzwischen geändert',
  secret_archived: 'Secret ist archiviert',
  not_found: 'Secret nicht gefunden',
};

/** Toast text for a failed approve/deny. */
export function decisionErrorText(e: unknown): string {
  if (isApiError(e, 'already_decided')) return 'Bereits entschieden';
  if (isApiError(e, 'expired')) return 'Abgelaufen';
  if (isApiError(e, 'apply_failed')) {
    const cause = e.details.cause ?? 'unbekannt';
    return `Änderung konnte nicht übernommen werden (${CAUSES[cause] ?? cause})`;
  }
  if (isApiError(e, 'plaintext_not_allowed')) return 'Klartext für dieses Secret nicht erlaubt';
  if (isApiError(e, 'device_inactive')) return 'Das Gerät ist nicht mehr aktiv. Die Anfrage wurde verweigert.';
  if (isApiError(e, 'not_found')) return 'Anfrage nicht gefunden';
  return 'Entscheidung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.';
}

/** Generic German error text for mutations; `fallback` describes what failed. */
export function errorText(e: unknown, fallback: string): string {
  if (isApiError(e, 'reauth_required')) return 'Bestätigung abgebrochen. Nichts wurde geändert.';
  if (isApiError(e, 'rate_limited')) return 'Zu viele Versuche. Warte eine Minute und versuche es erneut.';
  if (isApiError(e, 'secret_archived')) return 'Das Secret ist archiviert. Reaktiviere es zuerst.';
  if (isApiError(e, 'already_archived')) return 'Das Secret ist bereits archiviert.';
  if (isApiError(e, 'not_archived')) return 'Das Secret ist nicht archiviert.';
  if (isApiError(e, 'no_changes')) return 'Keine Änderungen zum Speichern.';
  if (isApiError(e, 'value_too_large')) return 'Der Wert ist größer als 64 KiB.';
  if (isApiError(e, 'forbidden') || isApiError(e, 'not_owner')) return 'Dafür fehlen dir die Rechte.';
  if (isApiError(e, 'not_found')) return 'Nicht gefunden. Lade die Seite neu.';
  return fallback;
}
