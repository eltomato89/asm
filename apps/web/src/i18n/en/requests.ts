import { createElement, Fragment, type ReactNode } from 'react';

const f = (...parts: ReactNode[]) => createElement(Fragment, null, ...parts);

export const requests = {
  title: 'Requests',
  openCount: (n: number) => `${n} open`,
  enableNotifications: 'Enable notifications',
  loadFailed: "Couldn't load requests. Reload the page.",
  notification: {
    title: 'New request',
    read: (device: string, secret: string, project: string) => `${device} wants ${secret} for ${project}`,
    update: (device: string, secret: string) => `${device} wants to change ${secret}`,
  },
  kbd: {
    approve: 'approve',
    deny: 'deny',
    nextPrev: 'next, previous',
    commands: 'commands',
  },
  recentActivity: 'Recent activity',
  toAuditLog: 'Open audit log',

  // Request card (also used by the public approve page)
  cardLabel: (name: string) => `Request ${name}`,
  cardLabelUpdate: (name: string) => `Change request ${name}`,
  kindRead: 'Access',
  kindUpdate: 'Change',
  received: (time: string) => `received ${time}`,
  sentenceRead: (host: ReactNode, secret: ReactNode, project: ReactNode) => f(host, ' wants ', secret, ' for ', project, '.'),
  sentenceUpdate: (host: ReactNode, secret: ReactNode) => f(host, ' wants to change ', secret, '.'),
  reason: 'Reason:',
  fields: {
    title: 'Title',
    description: 'Description',
    tags: 'Tags',
    envName: 'ENV name',
  } as Record<string, string>,
  becomes: 'becomes',
  value: 'Value',
  valueChanges: 'Value will change',
  previousValueKept: '(the previous value is kept as a version)',
  plaintextToAgent: 'Plaintext to agent',
  viaCli: 'via CLI handoff',
  deny: 'Deny',
  approve: 'Approve',
  timeLeft: 'Time remaining',
  expiresIn: 'expires in',

  // Queue
  toastApproved: (name: ReactNode, device: string) => f('Approved: ', name, ' for ', device),
  toastDenied: (name: ReactNode, device: string) => f('Denied: ', name, ' for ', device),
  emptyTitle: 'No open requests',
  emptyBody: 'New requests from agents appear here as soon as they arrive.',

  // Decided requests (/requests)
  decided: 'Decided',
  decidedEmptyTitle: 'No decided requests yet',
  decidedEmptyBody: 'Recent approvals and denials appear here.',
  /** `project` is null for change requests. */
  decidedSentence: (secret: ReactNode, host: ReactNode, project: ReactNode | null) =>
    f(secret, ' for ', host, project ? f(' in ', project) : ' (change)'),
  status: {
    approved: 'approved',
    denied: 'denied',
    expired: 'expired',
  },
  automatically: ', automatically',
  bySystem: ', by the system',
};
