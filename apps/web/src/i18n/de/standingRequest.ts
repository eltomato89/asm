import { createElement, Fragment, type ReactNode } from 'react';
import type { Messages } from '../en';

const f = (...parts: ReactNode[]) => createElement(Fragment, null, ...parts);
const days = (n: number) => (n === 1 ? '1 Tag' : `${n} Tage`);

export const standingRequest: Messages['standingRequest'] = {
  kind: 'Dauerfreigabe',
  cardLabel: (device) => `Anfrage nach Dauerfreigabe von ${device}`,
  sentence: (host, project) => f(host, ' möchte eine Dauerfreigabe', project ? f(' für ', project) : null, '.'),
  alsoApplies: (hosts) => `Gilt auch für asm auf ${hosts}.`,
  readsOnly: 'Nur Lesen. Änderungen an Secrets brauchen weiter deine Freigabe. Ändern oder beenden kannst du das später unter Geräte.',

  form: {
    vaults: 'Tresore',
    secrets: 'Secrets',
    vaultsHelp: 'Neue Secrets in diesen Tresoren sind ebenfalls abgedeckt.',
    unavailable: 'nicht mehr verfügbar',
    keepVault: 'Behalte mindestens einen Tresor oder verweigere.',
    keepSecret: 'Behalte mindestens ein Secret oder verweigere.',
    duration: 'Dauer',
    days,
    proposed: (label) => `${label} (vorgeschlagen)`,
    afterExpiry: 'Nach Ablauf',
    afterAsk: 'Jedes Mal fragen',
    afterRenew: 'Einmal fragen und verlängern',
    renewBy: 'Verlängern um',
    askFixed: 'Danach wird wieder jedes Mal gefragt.',
    narrowOnly: 'Hier kannst du den Vorschlag nur einschränken.',
    adjusted: 'Von dir angepasst:',
  },
  diff: {
    days: (to, from) => `${days(to)} statt ${from}`,
    removedVaults: (n) => (n === 1 ? '1 Tresor entfernt' : `${n} Tresore entfernt`),
    removedSecrets: (n) => (n === 1 ? '1 Secret entfernt' : `${n} Secrets entfernt`),
    afterAsk: 'fragt nach Ablauf jedes Mal statt zu verlängern',
    renewDays: (to, from) => (from === null ? `verlängert um ${days(to)}` : `verlängert um ${days(to)} statt ${from}`),
  },

  approve: 'Freigeben',
  deny: 'Verweigern',
  toastApproved: (device) => `Dauerfreigabe für ${device} erteilt.`,
  toastDenied: (device) => `Dauerfreigabe für ${device} verweigert.`,

  decidedSentence: (host) => f('Dauerfreigabe für ', host),
  status: {
    approved: 'freigegeben',
    denied: 'verweigert',
    expired: 'abgelaufen',
    cancelled: 'zurückgezogen',
  },
  adjustedSuffix: ', von dir angepasst',

  devicesBadge: 'Dauerfreigabe angefragt',
  devicesBadgeTitle: 'Anfrage auf der Seite Anfragen öffnen',
  notification: {
    title: 'Dauerfreigabe angefragt',
    body: (device) => `${device} fragt eine Dauerfreigabe an`,
  },

  page: {
    loading: 'Anfrage wird geladen',
    approvedBody: (n) => `hat eine Dauerfreigabe für ${days(n)}.`,
    deniedBody: 'erhält keine Dauerfreigabe.',
  },
};
