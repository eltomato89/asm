import type { Messages } from '../en';

export const approve: Messages['approve'] = {
  cancelled: 'Bestätigung abgebrochen. Nichts wurde freigegeben.',
  verificationFailed: 'Bestätigung fehlgeschlagen',
  noPasskey: 'Für dein Konto ist kein Passkey hinterlegt – lege im Heimnetz unter Einstellungen einen an.',
  badOrigin: 'Diese Seite wurde über eine unerwartete Adresse geöffnet. Öffne den Link aus der Benachrichtigung erneut.',
  invalidRequest: 'Ungültige Anfrage. Lade die Seite neu und versuche es erneut.',
  withFaceId: 'Mit Face ID freigeben',
  withPasskey: 'Mit Passkey freigeben',
  goneTitle: 'Diese Anfrage ist nicht mehr gültig.',
  goneBody: 'Sie wurde bereits entschieden oder ist abgelaufen.',
  approvedTitle: 'Freigegeben',
  deniedTitle: 'Verweigert',
  mayChange: (name) => `darf ${name} ändern.`,
  receives: (name) => `erhält ${name}.`,
  noAccess: (name) => `erhält keinen Zugriff auf ${name}.`,
  openApp: 'ASM öffnen',
  loadFailedTitle: 'Anfrage konnte nicht geladen werden',
  loadFailedBody: 'Prüfe die Verbindung und lade die Seite neu.',
  loading: 'Anfrage wird geladen',
  fieldChanges: (label) => `${label} wird geändert`,
};
