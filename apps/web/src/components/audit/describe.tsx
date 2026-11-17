import type { ReactNode } from 'react';
import { t } from '../../i18n';
import type { AuditCtx } from '../../i18n/en/audit';
import type { AuditRow } from '../../lib/api';
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
};

const Host = ({ children }: { children: ReactNode }) => <span className="host">{children}</span>;
const Sec = ({ children }: { children: ReactNode }) => <span className="secret">{children}</span>;
const Proj = ({ children }: { children: ReactNode }) => <span className="proj">{children}</span>;

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/** Readable sentence for an audit row ("claude@mbp received GITHUB_TOKEN for asm automatically"). */
export function describeAudit(r: AuditRow, names: Names): Described {
  const w = t.audit.words;
  const ev = t.audit.events;
  const meta = r.meta ?? {};
  const device = <Host>{names.device(r.deviceId) ?? (r.deviceId ? shortId(r.deviceId) : w.aDevice)}</Host>;
  const secretName = names.secret(r.secretId) ?? str(meta.envName) ?? str(meta.title) ?? (r.secretId ? shortId(r.secretId) : w.aSecret);
  const secret = <Sec>{secretName}</Sec>;
  const project = r.project ? <Proj>{r.project}</Proj> : null;

  // Subject: "You" (signed-in user), another user, a device or the system.
  const isMe = r.actorType === 'user' && r.actorId !== null && r.actorId === names.meId;
  const subject: ReactNode =
    r.actorType === 'device' ? device : isMe ? w.you : r.actorType === 'user' ? <strong>{names.user(r.actorId) ?? w.aUser}</strong> : 'ASM';
  const c: AuditCtx = { subject, me: isMe, device, secret, project };
  const tone = TONES[r.event] ?? 'neutral';
  const s = (sentence: ReactNode, note?: string): Described => ({ sentence, tone, ...(note ? { note } : {}) });

  switch (r.event) {
    case 'request.created':
      return s(ev.requestCreated(c, meta.kind === 'update'));
    case 'request.approved':
      return s(ev.requestApproved(c));
    case 'request.auto_approved':
      return s(ev.requestAutoApproved(c, <span className="muted">{w.automatically}</span>));
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
      return r.actorType === 'system' ? s(ev.revokedBySystem(c), str(meta.cause)) : s(ev.revoked(c));
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
export const isAutoEvent = (event: string) => event.includes('auto');

/** All event codes the server writes (filter options). */
export const AUDIT_EVENTS = [
  'request.created', 'request.approved', 'request.denied', 'request.auto_approved', 'request.expired',
  'grant.redeemed', 'grant.redeem_denied', 'secret.plaintext_delivered',
  'secret.created', 'secret.updated', 'secret.deleted', 'secret.revealed', 'secret.version_revealed', 'secret.version_restored',
  'secret.archived', 'secret.unarchived', 'secret.searched',
  'automode.enabled', 'automode.disabled',
  'auth.login', 'auth.login_failed',
  'device.pair_requested', 'device.approved', 'device.denied', 'device.revoked',
  'vault.member_added', 'vault.member_removed',
] as const;
