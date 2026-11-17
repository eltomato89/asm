import type { Messages } from '../en';

export const devices: Messages['devices'] = {
  title: 'Geräte',
  activeCount: (n) => `${n} aktiv`,
  enterCode: 'Code eingeben',
  ledeBefore: 'Agents koppeln sich über ihren MCP-Client oder mit ',
  ledeAfter: ' im Terminal. Widerrufene Geräte verlieren sofort alle Tokens und offenen Übergaben.',
  loadFailed: 'Geräte konnten nicht geladen werden. Lade die Seite neu.',
  emptyTitle: 'Noch keine Geräte gekoppelt',
  emptyBefore: 'Starte die Kopplung im MCP-Client oder mit ',
  emptyAfter: ' und gib den angezeigten Code ein.',
  status: {
    approved: 'aktiv',
    pending: 'wartet auf Freigabe',
    denied: 'abgelehnt',
    revoked: 'widerrufen',
  },
  col: {
    name: 'Name',
    kind: 'Typ',
    host: 'Host',
    lastUsed: 'Zuletzt genutzt',
    status: 'Status',
    actions: 'Aktionen',
  },
  never: 'nie',
  revoke: 'Widerrufen',
  revoked: (name) => `Zugriff von ${name} widerrufen.`,
  revokeFailed: 'Widerrufen fehlgeschlagen.',
  revokeTitle: (name) => `Zugriff von ${name} widerrufen?`,
  revokeText:
    'Das Gerät kann danach keine Secrets mehr suchen oder anfragen. Offene Anfragen und Übergaben verfallen sofort. Für einen neuen Zugriff muss es sich neu koppeln.',
  deviceName: 'Gerätename',
  rename: (name) => `${name} umbenennen`,
  renamed: 'Gerät umbenannt.',
  renameFailed: 'Umbenennen fehlgeschlagen.',
};
