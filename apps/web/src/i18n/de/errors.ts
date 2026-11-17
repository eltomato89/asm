import type { Messages } from '../en';

export const errors: Messages['errors'] = {
  causes: {
    stale: 'Secret wurde inzwischen geändert',
    secret_archived: 'Secret ist archiviert',
    not_found: 'Secret nicht gefunden',
  },
  unknownCause: 'unbekannt',
  alreadyDecided: 'Bereits entschieden',
  expired: 'Abgelaufen',
  applyFailed: (cause) => `Änderung konnte nicht übernommen werden (${cause})`,
  plaintextNotAllowed: 'Klartext für dieses Secret nicht erlaubt',
  deviceInactive: 'Das Gerät ist nicht mehr aktiv. Die Anfrage wurde verweigert.',
  requestNotFound: 'Anfrage nicht gefunden',
  decisionFailed: 'Entscheidung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.',
  reauthCancelled: 'Bestätigung abgebrochen. Nichts wurde geändert.',
  rateLimited: 'Zu viele Versuche. Warte eine Minute und versuche es erneut.',
  secretArchived: 'Das Secret ist archiviert. Reaktiviere es zuerst.',
  alreadyArchived: 'Das Secret ist bereits archiviert.',
  notArchived: 'Das Secret ist nicht archiviert.',
  noChanges: 'Keine Änderungen zum Speichern.',
  valueTooLarge: 'Der Wert ist größer als 64 KiB.',
  forbidden: 'Dafür fehlen dir die Rechte.',
  notFound: 'Nicht gefunden. Lade die Seite neu.',
};
