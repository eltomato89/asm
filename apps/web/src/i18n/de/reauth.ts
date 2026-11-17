import type { Messages } from '../en';

export const reauth: Messages['reauth'] = {
  title: 'Bestätige, dass du es bist',
  description: 'Diese Aktion braucht eine frische Anmeldung. Danach wird sie automatisch ausgeführt.',
  withPasskey: 'Mit Passkey bestätigen',
  usePassword: 'Stattdessen Passwort eingeben',
  password: 'Passwort',
  confirm: 'Bestätigen',
  invalidCredentials: 'Das hat nicht gepasst. Versuche es erneut.',
  rateLimited: 'Zu viele Versuche. Warte eine Minute und versuche es erneut.',
  passkeyCancelled: 'Passkey-Abfrage abgebrochen.',
  failed: 'Bestätigung fehlgeschlagen. Versuche es erneut.',
};
