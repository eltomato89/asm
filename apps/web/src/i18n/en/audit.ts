import { createElement, Fragment, type ReactNode } from 'react';

const f = (...parts: ReactNode[]) => createElement(Fragment, null, ...parts);

/** Pre-rendered parts of an audit sentence (see components/audit/describe.tsx). */
export type AuditCtx = {
  /** Actor: "You", another user, a device or "ASM". */
  subject: ReactNode;
  /** The actor is the signed-in user. */
  me: boolean;
  device: ReactNode;
  secret: ReactNode;
  /** Project chip, or null. */
  project: ReactNode | null;
};

const forProject = (c: AuditCtx) => (c.project ? f(' for ', c.project) : null);

export const audit = {
  title: 'Audit log',
  entries: (n: number, count: string, more: boolean) => `${count}${more ? '+' : ''} ${n === 1 && !more ? 'entry' : 'entries'}`,
  exportCsv: 'Export CSV',
  exported: 'CSV exported.',
  exportedTruncated: 'CSV exported, truncated to 10,000 entries.',
  exportFailed: 'Export failed. Try again.',
  truncatedNotice: 'The export only contains the newest 10,000 entries. Narrow the time range or filters to export older entries.',
  filters: 'Filters',
  all: 'All',
  device: 'Device',
  project: 'Project',
  event: 'Event',
  timeRange: 'Time range',
  ranges: {
    today: 'Today',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    all: 'All time',
  },
  resetFilters: 'Reset filters',
  tableLabel: 'Audit entries',
  colCode: 'Code',
  ipAddress: 'IP address',
  time: 'Time',
  loadFailedTitle: "Couldn't load entries",
  loadFailedBody: 'Reload the page.',
  emptyTitle: 'No entries for these filters',
  emptyBody: 'Change the time range or reset the filters.',
  loaded: (n: number, count: string) => `${count} ${n === 1 ? 'entry' : 'entries'} loaded`,
  loadMore: 'Load more',
  endOfLog: 'End of log',
  chain: {
    notChecked: 'Chain not verified',
    broken: (seq: number) => `Chain broken at #${seq}`,
    intact: 'Chain intact',
    intactTitle: 'All entries verified: every hash matches its predecessor.',
  },

  // Expanded row
  row: {
    hashCopied: 'Hash copied.',
    copyFailed: "Couldn't copy.",
    details: (seq: number) => `Details for entry ${seq}`,
    reason: 'Reason',
    secret: 'Secret',
    request: 'Request',
    meta: 'Meta',
    entry: 'Entry',
    hash: 'Hash',
    prevHash: 'Previous hash',
    youWebUi: 'You, web UI',
    webUi: 'Web UI',
    copyHash: 'Copy hash',
    onlySecret: (name: ReactNode) => f('Show only ', name),
  },

  // Secret filter
  secretFilter: {
    label: 'Secret',
    aria: (value: string) => `Secret: ${value}`,
    choose: 'Choose secret',
    search: 'Search secrets',
    list: 'Secrets',
    allSecrets: 'All secrets',
  },

  // Activity feed (overview)
  feed: {
    loading: 'Loading activity',
    loadFailed: "Couldn't load activity.",
    emptyTitle: 'No activity yet',
    emptyBody: 'Reads, approvals and changes appear here.',
  },

  // Event sentences
  words: {
    you: 'You',
    aUser: 'A user',
    aDevice: 'a device',
    aSecret: 'a secret',
    someUser: 'a user',
    someVault: 'a vault',
    automatically: 'automatically',
    minutes: (n: string) => `(${n} minutes)`,
    createdByAgent: 'newly created by an agent',
    automaticallyStanding: 'automatically (standing approval)',
    allSecrets: '(all secrets)',
    secretCount: (n: number) => `(${n} ${n === 1 ? 'secret' : 'secrets'})`,
    vaultCount: (n: number) => `(${n} ${n === 1 ? 'vault' : 'vaults'})`,
    vaultNames: (names: string[]) => `(${names.length === 1 ? 'vault' : 'vaults'} ${names.join(', ')})`,
    withUpdates: 'changes allowed too',
    thenAsk: 'afterwards, every request asks again',
    thenRenew: (days: string | null) => (days ? `the next request asks once to extend it by ${days} days` : 'the next request asks once to extend it'),
    deviceRevoked: 'device revoked',
    disabledByAdmin: 'standing approvals were turned off by the admin',
    renewalRequest: 'standing approval expired',
    renewedStanding: 'standing approval extended',
    viaPush: 'via push',
  },
  events: {
    requestCreated: (c: AuditCtx, update: boolean) => f(c.device, ' requested ', c.secret, forProject(c), update ? ' (change)' : ''),
    requestApproved: (c: AuditCtx) => f(c.subject, ' approved ', c.secret, ' for ', c.device),
    requestAutoApproved: (c: AuditCtx, auto: ReactNode) => f(c.device, ' received ', c.secret, forProject(c), ' ', auto),
    requestDeniedBySystem: (c: AuditCtx) => f('Request from ', c.device, ' for ', c.secret, ' was denied automatically'),
    requestDenied: (c: AuditCtx) => f(c.subject, ' denied ', c.secret, ' for ', c.device),
    requestExpired: (c: AuditCtx) => f('Request from ', c.device, ' for ', c.secret, ' expired'),
    grantRedeemed: (c: AuditCtx) => f(c.device, ' redeemed the handoff for ', c.secret),
    grantRedeemDenied: (c: AuditCtx) => f('Handoff of ', c.secret, ' to ', c.device, ' was refused'),
    plaintextDelivered: (c: AuditCtx) => f(c.secret, ' was delivered in plaintext to ', c.device),
    secretCreated: (c: AuditCtx) => f(c.subject, ' created ', c.secret, c.project ? f(' in ', c.project) : null),
    secretUpdated: (c: AuditCtx, version?: string) => f(c.subject, ' changed ', c.secret, version ? `, now version ${version}` : ''),
    versionRestored: (c: AuditCtx, version: string) => f(c.subject, ' restored ', c.secret, ' to version ', version),
    secretDeleted: (c: AuditCtx, name: ReactNode) => f(c.subject, ' deleted ', name),
    revealed: (c: AuditCtx) => f(c.subject, ' revealed the value of ', c.secret),
    versionRevealed: (c: AuditCtx, version: string) => f(c.subject, ' revealed version ', version, ' of ', c.secret),
    archived: (c: AuditCtx) => f(c.subject, ' archived ', c.secret),
    unarchived: (c: AuditCtx) => f(c.subject, ' restored ', c.secret),
    searched: (c: AuditCtx, query: string) => f(c.device, ' searched for “', query, '”', forProject(c)),
    autoModeEnabled: (c: AuditCtx, minutes: ReactNode) => f(c.subject, ' turned on auto mode ', minutes),
    autoModeExpired: 'Auto mode expired',
    autoModeDisabled: (c: AuditCtx) => f(c.subject, ' turned off auto mode'),
    login: (c: AuditCtx, passkey: boolean) => f(c.subject, ' signed in', passkey ? ' with a passkey' : ''),
    loginFailed: (user: ReactNode | null) => f('Failed sign-in', user ? f(' for ', user) : null),
    pairRequested: (c: AuditCtx) => f(c.device, ' wants to connect to ASM'),
    deviceApproved: (c: AuditCtx) => f(c.subject, ' paired the device ', c.device),
    deviceDenied: (c: AuditCtx, client: ReactNode | null) => f(c.subject, ' denied the pairing request', client ? f(' from ', client) : null),
    revokedBySystem: (c: AuditCtx) => f('Access for ', c.device, ' was revoked'),
    revoked: (c: AuditCtx) => f(c.subject, ' revoked access for ', c.device),
    standingSet: (c: AuditCtx, until: ReactNode, scope: ReactNode, changed: boolean) =>
      changed
        ? f(c.subject, ' changed the standing approval for ', c.device, ', now until ', until, ' ', scope)
        : f(c.subject, ' set a standing approval for ', c.device, ' until ', until, ' ', scope),
    standingRemoved: (c: AuditCtx) => f(c.subject, ' removed the standing approval for ', c.device),
    standingRemovedRevoked: (c: AuditCtx) => f('The standing approval for ', c.device, ' was removed'),
    standingRenewed: (c: AuditCtx, days: string, until: ReactNode) =>
      f(c.subject, ' extended the standing approval for ', c.device, ' by ', days, ' days, until ', until),
    standingExpired: (c: AuditCtx) => f('The standing approval for ', c.device, ' expired'),
    standingSecretAdded: (c: AuditCtx) => f(c.device, ' created ', c.secret, ', which was added to its standing approval'),
    memberAdded: (c: AuditCtx, who: ReactNode, vault: ReactNode) => f(c.subject, ' added ', who, ' to the vault ', vault),
    memberRemoved: (c: AuditCtx, who: ReactNode, vault: ReactNode) => f(c.subject, ' removed ', who, ' from the vault ', vault),
  },
};
