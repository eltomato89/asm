import type { Messages } from '../en';

export const layout: Messages['layout'] = {
  switchVault: (name) => `Tresor wechseln, aktuell ${name}`,
  selected: 'ausgewählt',
  manageVaults: 'Tresore verwalten',
  mainNav: 'Hauptnavigation',
  pendingCount: (n) => `${n} offen`,
  openNav: 'Navigation öffnen',
  openPalette: 'Befehlspalette öffnen',
  appearance: 'Darstellung',
  themeSystem: 'System',
  themeLight: 'Hell',
  themeDark: 'Dunkel',
  account: (name) => `Konto ${name}`,
  signedInAs: 'Angemeldet als',
  signOut: 'Abmelden',
  ctrlKey: 'Strg',
  routeErrorBody: 'Diese Ansicht konnte nicht angezeigt werden. Lade die Seite neu. Bleibt der Fehler, prüfe die Verbindung zum Server.',
  typeToConfirm: (text) => `Zum Bestätigen „${text}“ eingeben`,
};
