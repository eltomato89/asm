import type { ReactNode } from 'react';
import { t } from '../../i18n';
import type { AuditCtx } from '../../i18n/en/audit';
import type { AuditRow } from '../../lib/api';
import { formatAbsolute, formatDay } from '../../lib/format';
import type { Names } from '../../lib/names';

export type Tone = 'ok' | 'danger' | 'amber' | 'neutral';

export type Described = {
  sentence: ReactNode;
  tone: Tone;
  /** Extra quiet note after the sentence (e.g. "newly created by an agent"). */
  note?: string;
};

const TONES: Record<string, Tone> = {
  'request.approved': 'ok',
  'request.auto_approved': 'ok',
  'device.approved': 'ok',
  'request.denied': 'danger',
  'device.denied': 'danger',
  'device.revoked': 'danger',
  'grant.redeem_denied': 'danger',
  'auth.login_failed': 'danger',
  'automode.enabled': 'amber',
  'automode.disabled': 'amber',
  'standing_approval.set': 'amber',
  'standing_approval.removed': 'amber',
  'standing_approval.renewed': 'amber',
  'standing_approval.expired': 'amber',
  'standing_approval.secret_added': 'amber',
};

const Host = ({ children }: { children: ReactNode }) => <span className="host">{children}</span>;
const Sec = ({ children }: { children: ReactNode }) => <span className="secret">{children}</span>;
const Proj = ({ children }: { children: ReactNode }) => <span className="proj">{children}</span>;

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** Day of a timestamp in meta, with the exact time as tooltip. */
const Day = ({ ts }: { ts: number | undefined }) => (ts === undefined ? <>?</> : <time dateTime={new Date(ts).toISOString()} title={formatAbsolute(ts)}>{formatDay(ts)}</time>);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/** Max. vault names spelled out in a standing approval sentence; more become "(N vaults)". */
const MAX_VAULT_NAMES = 3;
/** "(vaults Work, Ops)" when every vault id is known, otherwise "(N vaults)". */
function vaultScope(meta: Record<string, unknown>, names: Names): string {
  const w = t.audit.words;
  const ids = Array.isArray(meta.vaultIds) ? meta.vaultIds.filter((v): v is string => typeof v === 'string') : [];
  const labels = ids.map((id) => names.vault(id));
  if (ids.length > 0 && ids.length <= MAX_VAULT_NAMES && labels.every((l) => l !== undefined)) return w.vaultNames(labels as string[]);
  return w.vaultCount(num(meta.vaultCount) ?? ids.length);
}

/** Readable sentence for an audit row ("claude@mbp received GITHUB_TOKEN for asm automatically"). */
export function describeAudit(r: AuditRow, names: Names): Described {
  const w = t.audit.words;
  const ev = t.audit.events;
  const meta = r.meta ?? {};
  const device = <Host>{names.device(r.deviceId) ?? (r.deviceId ? shortId(r.deviceId) : w.aDevice)}</Host>;
  const secretName = names.secret(r.secretId) ?? str(meta.envName) ?? str(meta.title) ?? (r.secretId ? shortId(r.secretId) : w.aSecret);
  const secret = <Sec>{secretName}</Sec>;
  const project = r.project ? <Proj>{r.project}</Proj> : null;
  /** Another device named in meta (e.g. the main device of a link). */
  const deviceRef = (v: unknown) => {
    const other = str(v);
    return <Host>{(other && names.device(other)) ?? (other ? shortId(other) : w.aDevice)}</Host>;
  };

  // Subject: "You" (signed-in user), another user, a device or the system.
  const isMe = r.actorType === 'user' && r.actorId !== null && r.actorId === names.meId;
  const subject: ReactNode =
    r.actorType === 'device' ? device : isMe ? w.you : r.actorType === 'user' ? <strong>{names.user(r.actorId) ?? w.aUser}</strong> : 'ASM';
  const c: AuditCtx = { subject, me: isMe, device, secret, project };
  const tone = TONES[r.event] ?? 'neutral';
  const s = (sentence: ReactNode, note?: string): Described => ({ sentence, tone, ...(note ? { note } : {}) });

  switch (r.event) {
    case 'request.created':
      return s(ev.requestCreated(c, meta.kind === 'update'), meta.renewal === true || meta.renewal === 'true' ? w.renewalRequest : undefined);
    case 'request.approved':
      return s(ev.requestApproved(c), meta.renewed === true || meta.renewed === 'true' ? w.renewedStanding : undefined);
    case 'request.auto_approved':
      return s(ev.requestAutoApproved(c, <span className="muted">{meta.via === 'standing' ? w.automaticallyStanding : w.automatically}</span>));
    case 'standing_approval.set': {
      const count = num(meta.secretCount);
      const scope = <span className="muted">{meta.scope === 'vaults' ? vaultScope(meta, names) : meta.scope === 'list' && count !== undefined ? w.secretCount(count) : w.allSecrets}</span>;
      const changed = meta.previous !== undefined && meta.previous !== null;
      const after = meta.afterExpiry === 'renew' ? w.thenRenew(str(meta.renewDays) ?? null) : w.thenAsk;
      const note = meta.allowUpdates === true || meta.allowUpdates === 'true' ? `${w.withUpdates}; ${after}` : after;
      return s(ev.standingSet(c, <Day ts={num(meta.until)} />, scope, changed), note);
    }
    case 'standing_approval.removed':
      if (meta.cause === 'device_linked') return s(ev.standingRemovedRevoked(c), w.deviceLinked);
      if (meta.cause === 'disabled_by_admin') return s(ev.standingRemovedRevoked(c), w.disabledByAdmin);
      return meta.cause === 'device_revoked' || r.actorType === 'system' ? s(ev.standingRemovedRevoked(c), w.deviceRevoked) : s(ev.standingRemoved(c));
    case 'standing_approval.renewed':
      return s(ev.standingRenewed(c, str(meta.days) ?? '?', <Day ts={num(meta.until)} />), meta.via === 'push' ? w.viaPush : undefined);
    case 'standing_approval.expired':
      return s(ev.standingExpired(c), meta.afterExpiry === 'renew' ? w.thenRenew(str(meta.renewDays) ?? null) : meta.afterExpiry === 'ask' ? w.thenAsk : undefined);
    case 'standing_approval.secret_added':
      return s(ev.standingSecretAdded(c));
    case 'request.denied':
      if (r.actorType === 'system') return s(ev.requestDeniedBySystem(c), str(meta.cause));
      return s(ev.requestDenied(c));
    case 'request.expired':
      return s(ev.requestExpired(c));
    case 'grant.redeemed':
      return s(ev.grantRedeemed(c));
    case 'grant.redeem_denied':
      return s(ev.grantRedeemDenied(c), str(meta.cause));
    case 'secret.plaintext_delivered':
      return s(ev.plaintextDelivered(c));
    case 'secret.created':
      return s(ev.secretCreated(c), r.actorType === 'device' ? w.createdByAgent : undefined);
    case 'secret.updated':
      return s(ev.secretUpdated(c, str(meta.version)));
    case 'secret.version_restored':
      return s(ev.versionRestored(c, str(meta.restoredFrom) ?? '?'));
    case 'secret.deleted':
      return s(ev.secretDeleted(c, <Sec>{str(meta.title) ?? secretName}</Sec>));
    case 'secret.revealed':
      return s(ev.revealed(c));
    case 'secret.version_revealed':
      return s(ev.versionRevealed(c, str(meta.version) ?? '?'));
    case 'secret.archived':
      return s(ev.archived(c));
    case 'secret.unarchived':
      return s(ev.unarchived(c));
    case 'secret.searched':
      return s(ev.searched(c, str(meta.query) ?? ''));
    case 'automode.enabled':
      return s(ev.autoModeEnabled(c, <span className="muted">{w.minutes(str(meta.minutes) ?? '?')}</span>));
    case 'automode.disabled':
      return meta.cause === 'expired' ? s(ev.autoModeExpired) : s(ev.autoModeDisabled(c));
    case 'auth.login':
      return s(ev.login(c, meta.method === 'passkey'));
    case 'auth.login_failed': {
      const username = str(meta.username);
      return s(ev.loginFailed(username ? <strong>{username}</strong> : null));
    }
    case 'device.pair_requested':
      return s(ev.pairRequested(c));
    case 'device.approved':
      return s(ev.deviceApproved(c));
    case 'device.denied': {
      const client = str(meta.clientName);
      return s(ev.deviceDenied(c, client ? <Host>{client}</Host> : null));
    }
    case 'device.revoked':
      if (meta.cause === 'main_revoked') return s(r.actorType === 'system' ? ev.revokedBySystem(c) : ev.revoked(c), w.mainRevoked);
      return r.actorType === 'system' ? s(ev.revokedBySystem(c), str(meta.cause)) : s(ev.revoked(c));
    case 'device.default_vault_changed': {
      // The vault column holds the new effective default (personal when meta.vaultId is null).
      const vault = <strong>{names.vault(r.vaultId) ?? (meta.vaultId === null ? t.vaults.personal : w.someVault)}</strong>;
      if (meta.cause === 'device_linked') return s(ev.defaultVaultCleared(c), w.deviceLinked);
      return meta.cause === 'member_removed' ? s(ev.defaultVaultReset(c, vault), w.memberRemoved) : s(ev.defaultVaultChanged(c, vault));
    }
    case 'device.linked': {
      const main = deviceRef(meta.mainDeviceId);
      const notes: string[] = [];
      if (meta.cause === 'activation') notes.push(w.duringPairing);
      const previous = str(meta.previousMainDeviceId);
      if (previous) notes.push(w.previouslyLinkedTo(names.device(previous) ?? shortId(previous)));
      if (meta.droppedStanding === true || meta.droppedStanding === 'true') notes.push(w.droppedStanding);
      if (str(meta.previousDefaultVaultId)) notes.push(w.droppedVault);
      return s(ev.deviceLinked(c, main), notes.length ? notes.join('; ') : undefined);
    }
    case 'device.unlinked': {
      const main = deviceRef(meta.mainDeviceId);
      return meta.cause === 'main_revoked' ? s(ev.deviceUnlinkedBySystem(c, main), w.mainRevoked) : s(ev.deviceUnlinked(c, main));
    }
    case 'vault.member_added':
    case 'vault.member_removed': {
      const who = <strong>{names.user(str(meta.userId)) ?? w.someUser}</strong>;
      const vault = <strong>{names.vault(r.vaultId) ?? w.someVault}</strong>;
      return r.event === 'vault.member_added' ? s(ev.memberAdded(c, who, vault)) : s(ev.memberRemoved(c, who, vault));
    }
    default:
      return s(<span className="mono">{r.event}</span>);
  }
}

export const toneDot = (t: Tone) => (t === 'neutral' ? 'dot' : `dot dot-${t}`);
export const isAutoEvent = (event: string) => event.includes('auto') || event.startsWith('standing_approval.');

/** All event codes the server writes (filter options). */
export const AUDIT_EVENTS = [
  'request.created', 'request.approved', 'request.denied', 'request.auto_approved', 'request.expired',
  'grant.redeemed', 'grant.redeem_denied', 'secret.plaintext_delivered',
  'secret.created', 'secret.updated', 'secret.deleted', 'secret.revealed', 'secret.version_revealed', 'secret.version_restored',
  'secret.archived', 'secret.unarchived', 'secret.searched',
  'automode.enabled', 'automode.disabled',
  'standing_approval.set', 'standing_approval.removed', 'standing_approval.renewed', 'standing_approval.expired', 'standing_approval.secret_added',
  'auth.login', 'auth.login_failed',
  'device.pair_requested', 'device.approved', 'device.denied', 'device.revoked', 'device.default_vault_changed', 'device.linked', 'device.unlinked',
  'vault.member_added', 'vault.member_removed',
] as const;
