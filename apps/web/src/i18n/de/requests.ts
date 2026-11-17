import { createElement, Fragment, type ReactNode } from 'react';
import type { Messages } from '../en';

const f = (...parts: ReactNode[]) => createElement(Fragment, null, ...parts);

export const requests: Messages['requests'] = {
  title: 'Anfragen',
  openCount: (n) => `${n} offen`,
  enableNotifications: 'Benachrichtigungen aktivieren',
  loadFailed: 'Anfragen konnten nicht geladen werden. Lade die Seite neu.',
  notification: {
    title: 'Neue Anfrage',
    read: (device, secret, project) => `${device} möchte ${secret} für ${project}`,
    update: (device, secret) => `${device} möchte ${secret} ändern`,
  },
  kbd: {
    approve: 'freigeben',
    deny: 'verweigern',
    nextPrev: 'nächste, vorige',
    commands: 'Befehle',
  },
  recentActivity: 'Letzte Aktivität',
  toAuditLog: 'Zum Audit-Log',

  cardLabel: (name) => `Anfrage ${name}`,
  cardLabelUpdate: (name) => `Änderungsanfrage ${name}`,
  kindRead: 'Abruf',
  kindUpdate: 'Änderung',
  received: (time) => `eingegangen ${time}`,
  sentenceRead: (host, secret, project) => f(host, ' möchte ', secret, ' für ', project, '.'),
  sentenceUpdate: (host, secret) => f(host, ' möchte ', secret, ' ändern.'),
  reason: 'Grund:',
  fields: {
    title: 'Titel',
    description: 'Beschreibung',
    tags: 'Tags',
    envName: 'ENV-Name',
  },
  becomes: 'wird zu',
  value: 'Wert',
  valueChanges: 'Wert wird geändert',
  previousValueKept: '(bisheriger Wert bleibt als Version erhalten)',
  plaintextToAgent: 'Klartext an Agent',
  viaCli: 'via CLI-Übergabe',
  deny: 'Verweigern',
  approve: 'Freigeben',
  renewal: (days, until) =>
    `Dauerfreigabe abgelaufen. Mit dieser Freigabe wird sie um ${days} ${days === 1 ? 'Tag' : 'Tage'} verlängert (bis ${until}).`,
  timeLeft: 'Verbleibende Zeit',
  expiresIn: 'läuft ab in',

  toastApproved: (name, device) => f('Freigegeben: ', name, ' für ', device),
  toastDenied: (name, device) => f('Verweigert: ', name, ' für ', device),
  emptyTitle: 'Keine offenen Anfragen',
  emptyBody: 'Neue Anfragen von Agents erscheinen hier, sobald sie eintreffen.',

  decided: 'Entschieden',
  decidedEmptyTitle: 'Noch keine entschiedenen Anfragen',
  decidedEmptyBody: 'Freigaben und Ablehnungen der letzten Zeit erscheinen hier.',
  decidedSentence: (secret, host, project) => f(secret, ' für ', host, project ? f(' in ', project) : ' (Änderung)'),
  status: {
    approved: 'freigegeben',
    denied: 'verweigert',
    expired: 'abgelaufen',
  },
  automatically: ', automatisch',
  viaStanding: ', per Dauerfreigabe',
  bySystem: ', vom System',
};
