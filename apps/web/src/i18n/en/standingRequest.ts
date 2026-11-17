import { createElement, Fragment, type ReactNode } from 'react';

const f = (...parts: ReactNode[]) => createElement(Fragment, null, ...parts);
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

// Standing approvals proposed by an agent: request card, narrow-only form, push page, devices badge.
export const standingRequest = {
  kind: 'Standing access',
  cardLabel: (device: string) => `Standing access request from ${device}`,
  /** "<device> wants standing access for <project>." */
  sentence: (host: ReactNode, project: ReactNode | null) => f(host, ' wants standing access', project ? f(' for ', project) : null, '.'),
  /** Attached CLIs are covered by the approval too. */
  alsoApplies: (hosts: string) => `Also applies to asm on ${hosts}.`,
  readsOnly: 'Reading only. Changing a secret still needs your approval. You can change or end this later under Devices.',

  // Narrow-only form
  form: {
    vaults: 'Vaults',
    secrets: 'Secrets',
    vaultsHelp: 'New secrets in these vaults are covered too.',
    unavailable: 'no longer available',
    keepVault: 'Keep at least one vault, or deny.',
    keepSecret: 'Keep at least one secret, or deny.',
    duration: 'Duration',
    days,
    proposed: (label: string) => `${label} (proposed)`,
    afterExpiry: 'After it expires',
    afterAsk: 'Ask every time',
    afterRenew: 'Ask once and extend',
    renewBy: 'Extend by',
    askFixed: 'Afterwards, every request asks again.',
    narrowOnly: 'You can only narrow the proposal here.',
    adjusted: 'Adjusted by you:',
  },
  // What changed relative to the proposal (form line, audit note)
  diff: {
    days: (to: number, from: number) => `${days(to)} instead of ${from}`,
    removedVaults: (n: number) => (n === 1 ? '1 vault removed' : `${n} vaults removed`),
    removedSecrets: (n: number) => (n === 1 ? '1 secret removed' : `${n} secrets removed`),
    afterAsk: 'asks every time after expiry instead of extending',
    renewDays: (to: number, from: number | null) => (from === null ? `extends by ${days(to)}` : `extends by ${days(to)} instead of ${from}`),
  },

  approve: 'Approve',
  deny: 'Deny',
  toastApproved: (device: string) => `Standing access for ${device} approved.`,
  toastDenied: (device: string) => `Standing access for ${device} denied.`,

  // Decided list (/requests)
  decidedSentence: (host: ReactNode) => f('Standing access for ', host),
  status: {
    approved: 'approved',
    denied: 'denied',
    expired: 'expired',
    cancelled: 'withdrawn',
  },
  adjustedSuffix: ', adjusted by you',

  devicesBadge: 'Standing access requested',
  devicesBadgeTitle: 'Open the request on the Requests page',
  notification: {
    title: 'Standing access requested',
    body: (device: string) => `${device} asks for standing access`,
  },

  // Public push page (/approve/standing/:token)
  page: {
    loading: 'Loading request',
    approvedBody: (n: number) => `has standing access for ${days(n)}.`,
    deniedBody: 'gets no standing access.',
  },
};
