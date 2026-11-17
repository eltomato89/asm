import type { Messages } from '../en';

export const palette: Messages['palette'] = {
  title: 'Befehlspalette',
  placeholder: 'Secret, Seite oder Befehl suchen',
  results: 'Ergebnisse',
  noResults: (q) => `Nichts gefunden für „${q}“.`,
  footSelect: 'auswählen',
  footOpen: 'öffnen',
  footClose: 'schließen',
  groupPages: 'Seiten',
  groupActions: 'Aktionen',
  groupSecrets: 'Secrets',
  pageHint: 'Seite',
  toggleTheme: 'Hell/Dunkel umschalten',
};
