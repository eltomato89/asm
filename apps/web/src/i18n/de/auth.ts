import type { Messages } from '../en';

export const auth: Messages['auth'] = {
  username: 'Benutzername',
  password: 'Passwort',
  rateLimited: 'Zu viele Versuche. Warte eine Minute und versuche es erneut.',
  login: {
    title: 'Anmelden',
    ledeBefore: 'bei ASM auf ',
    withPasskey: 'Mit Passkey anmelden',
    noPasskeySupport: 'Dieser Browser unterstützt keine Passkeys.',
    orPassword: 'oder mit Passwort',
    submit: 'Anmelden',
    invalidCredentials: 'Benutzername oder Passwort ist falsch.',
    missingFields: 'Gib Benutzername und Passwort ein.',
    failed: 'Anmeldung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.',
    passkeyCancelled: 'Anmeldung mit Passkey abgebrochen.',
    passkeyUnknown: 'Dieser Passkey ist hier nicht registriert. Melde dich mit Passwort an.',
    passkeyFailed: 'Anmeldung mit Passkey fehlgeschlagen.',
  },
  setup: {
    title: 'ASM einrichten',
    lede: 'Lege das erste Konto an. Es erhält Administratorrechte.',
    token: 'Einrichtungs-Token',
    tokenHelp: 'Steht beim ersten Start im Container-Log in der Zeile „ASM setup token“.',
    usernameHelp: '3–64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.',
    passwordHelp: (min) => `Mindestens ${min} Zeichen. Einen Passkey kannst du danach in den Einstellungen hinzufügen.`,
    submit: 'Konto anlegen',
    created: 'Konto angelegt. Melde dich jetzt an.',
    invalidToken: 'Das Token stimmt nicht. Kopiere es erneut aus dem Container-Log.',
    invalidInput: (min) => `Benutzername: 3–64 Zeichen aus Buchstaben, Ziffern, . _ -. Passwort: mindestens ${min} Zeichen.`,
    failed: 'Einrichtung fehlgeschlagen. Prüfe die Verbindung und versuche es erneut.',
  },
};
