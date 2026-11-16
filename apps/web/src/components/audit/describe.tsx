import type { ReactNode } from 'react';
import type { AuditRow } from '../../lib/api';
import type { Names } from '../../lib/names';

export type Tone = 'ok' | 'danger' | 'amber' | 'neutral';

export type Described = {
  sentence: ReactNode;
  tone: Tone;
  /** Extra quiet note after the sentence (e.g. "neu von Agent angelegt"). */
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

/** Readable German sentence for an audit row ("claude@mbp erhielt GITHUB_TOKEN für asm automatisch"). */
export function describeAudit(r: AuditRow, names: Names): Described {
  const meta = r.meta ?? {};
  const device = <Host>{names.device(r.deviceId) ?? (r.deviceId ? shortId(r.deviceId) : 'ein Gerät')}</Host>;
  const secretName = names.secret(r.secretId) ?? str(meta.envName) ?? str(meta.title) ?? (r.secretId ? shortId(r.secretId) : 'ein Secret');
  const secret = <Sec>{secretName}</Sec>;
  const forProject = r.project ? (
    <>
      {' '}
      für <Proj>{r.project}</Proj>
    </>
  ) : null;

  // Subject: "Du" (signed-in user), another user, a device or the system.
  const isMe = r.actorType === 'user' && r.actorId !== null && r.actorId === names.meId;
  const subject: ReactNode =
    r.actorType === 'device' ? device : isMe ? 'Du' : r.actorType === 'user' ? <strong>{names.user(r.actorId) ?? 'Ein Nutzer'}</strong> : 'ASM';
  const hat = isMe ? 'hast' : 'hat';
  const tone = TONES[r.event] ?? 'neutral';
  const s = (sentence: ReactNode, note?: string): Described => ({ sentence, tone, ...(note ? { note } : {}) });

  switch (r.event) {
    case 'request.created':
      return s(<>{device} fragt {secret}{forProject} an{meta.kind === 'update' ? ' (Änderung)' : ''}</>);
    case 'request.approved':
      return s(<>{subject} {hat} {secret} für {device} freigegeben</>);
    case 'request.auto_approved':
      return s(<>{device} erhielt {secret}{forProject} <span className="muted">automatisch</span></>);
    case 'request.denied':
      if (r.actorType === 'system') return s(<>Anfrage von {device} für {secret} wurde automatisch verweigert</>, str(meta.cause));
      return s(<>{subject} {hat} {secret} für {device} verweigert</>);
    case 'request.expired':
      return s(<>Anfrage von {device} für {secret} ist abgelaufen</>);
    case 'grant.redeemed':
      return s(<>{device} hat die Übergabe für {secret} eingelöst</>);
    case 'grant.redeem_denied':
      return s(<>Übergabe von {secret} an {device} abgelehnt</>, str(meta.cause));
    case 'secret.plaintext_delivered':
      return s(<>{secret} wurde im Klartext an {device} übergeben</>);
    case 'secret.created':
      return s(
        <>
          {subject} {hat} {secret}
          {r.project ? (
            <>
              {' '}
              in <Proj>{r.project}</Proj>
            </>
          ) : null}{' '}
          angelegt
        </>,
        r.actorType === 'device' ? 'neu von Agent angelegt' : undefined,
      );
    case 'secret.updated':
      return s(<>{subject} {hat} {secret} geändert{str(meta.version) ? `, jetzt Version ${str(meta.version)}` : ''}</>);
    case 'secret.version_restored':
      return s(<>{subject} {hat} {secret} auf Version {str(meta.restoredFrom) ?? '?'} zurückgesetzt</>);
    case 'secret.deleted':
      return s(<>{subject} {hat} <Sec>{str(meta.title) ?? secretName}</Sec> gelöscht</>);
    case 'secret.revealed':
      return s(<>{subject} {hat} den Wert von {secret} angezeigt</>);
    case 'secret.version_revealed':
      return s(<>{subject} {hat} Version {str(meta.version) ?? '?'} von {secret} angezeigt</>);
    case 'secret.archived':
      return s(<>{subject} {hat} {secret} archiviert</>);
    case 'secret.unarchived':
      return s(<>{subject} {hat} {secret} reaktiviert</>);
    case 'secret.searched':
      return s(<>{device} hat nach „{str(meta.query) ?? ''}“ gesucht{forProject}</>);
    case 'automode.enabled':
      return s(<>{subject} {hat} den Auto-Modus aktiviert <span className="muted">({str(meta.minutes) ?? '?'} Minuten)</span></>);
    case 'automode.disabled':
      return meta.cause === 'expired' ? s(<>Der Auto-Modus ist abgelaufen</>) : s(<>{subject} {hat} den Auto-Modus beendet</>);
    case 'auth.login':
      return s(<>{subject} {hat} {isMe ? 'dich' : 'sich'} {meta.method === 'passkey' ? 'mit Passkey ' : ''}angemeldet</>);
    case 'auth.login_failed':
      return s(<>Fehlgeschlagene Anmeldung{str(meta.username) ? <> für <strong>{str(meta.username)}</strong></> : null}</>);
    case 'device.pair_requested':
      return s(<>{device} möchte sich mit ASM verbinden</>);
    case 'device.approved':
      return s(<>{subject} {hat} das Gerät {device} gekoppelt</>);
    case 'device.denied':
      return s(<>{subject} {hat} die Kopplung {str(meta.clientName) ? <>von <Host>{str(meta.clientName)}</Host> </> : null}verweigert</>);
    case 'device.revoked':
      return r.actorType === 'system' ? s(<>Der Zugriff von {device} wurde widerrufen</>, str(meta.cause)) : s(<>{subject} {hat} den Zugriff von {device} widerrufen</>);
    case 'vault.member_added':
    case 'vault.member_removed': {
      const who = <strong>{names.user(str(meta.userId)) ?? 'einen Nutzer'}</strong>;
      const vault = <strong>{names.vault(r.vaultId) ?? 'einem Tresor'}</strong>;
      return r.event === 'vault.member_added'
        ? s(<>{subject} {hat} {who} zum Tresor {vault} hinzugefügt</>)
        : s(<>{subject} {hat} {who} aus dem Tresor {vault} entfernt</>);
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
