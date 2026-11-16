import { createHash, randomBytes } from 'node:crypto';
import { newId, type PushSubscribeInput, type PushSubscriptionDto } from '@asm/shared';
import { sendNotification } from 'web-push';
import type { Clock } from '../clock.js';
import type { ServiceCtx, ServiceLogger } from '../context.js';
import type { Db } from '../db/client.js';
import { HttpError } from '../errors.js';
import type { VapidKeys } from './vapid.js';

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushSendOptions = {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  urgency: 'high';
  /** Socket timeout in ms (web-push has none by default). */
  timeout: number;
};
/** Sends one encrypted Web Push message; rejects with an error carrying `statusCode` on push-service errors. */
export type PushSender = (target: PushTarget, payload: string, opts: PushSendOptions) => Promise<unknown>;

export const defaultPushSender: PushSender = (target, payload, opts) => sendNotification(target, payload, opts);

/** JSON inside the encrypted push message (read by /sw.js). Deliberately neutral: shown on the lock screen. */
export type PushPayload = { title: string; body: string; url: string; tag: string };

export const PUSH_TTL_SECONDS = 300;
export const PUSH_TIMEOUT_MS = 10_000;

/** Known Web Push services (FCM/Chrome, Apple, Mozilla, Windows). Subscriptions elsewhere are refused (no SSRF). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}
export const MAX_SUBSCRIPTIONS_PER_USER = 20;
export const TEST_PAYLOAD: PushPayload = { title: 'ASM', body: 'Test-Benachrichtigung', url: '/settings', tag: 'asm-test' };
export const pendingPayload = (token: string, requestId: string): PushPayload => ({
  title: 'ASM', body: 'Neue Anfrage wartet auf Freigabe', url: `/approve/${token}`, tag: requestId,
});

export const hashApproveToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

type SubRow = {
  id: string; user_id: string; endpoint: string; p256dh: string; auth: string; device_name: string; created_at: number; last_used_at: number | null;
};

const toDto = (r: SubRow): PushSubscriptionDto => ({ id: r.id, deviceName: r.device_name, createdAt: r.created_at, lastUsedAt: r.last_used_at });

// ---------- subscriptions ----------

export function listSubscriptions(db: Db, userId: string): PushSubscriptionDto[] {
  return (db.$client.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id').all(userId) as SubRow[]).map(toDto);
}

/** Stores a subscription; the same endpoint re-subscribing (same user) updates keys and name in place, another user's → 409. */
export function upsertSubscription(db: Db, clock: Clock, userId: string, input: PushSubscribeInput): PushSubscriptionDto {
  const { endpoint, keys } = input.subscription;
  if (!isAllowedPushEndpoint(endpoint)) throw new HttpError(400, 'unsupported_push_service');
  return db.$client.transaction(() => {
    const existing = db.$client.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as SubRow | undefined;
    if (existing) {
      if (existing.user_id !== userId) throw new HttpError(409, 'subscription_conflict');
      db.$client
        .prepare('UPDATE push_subscriptions SET p256dh = ?, auth = ?, device_name = ? WHERE id = ?')
        .run(keys.p256dh, keys.auth, input.deviceName, existing.id);
      return toDto({ ...existing, p256dh: keys.p256dh, auth: keys.auth, device_name: input.deviceName });
    }
    const n = (db.$client.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
    if (n >= MAX_SUBSCRIPTIONS_PER_USER) throw new HttpError(409, 'too_many_subscriptions');
    const row: SubRow = {
      id: newId('psh'), user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, device_name: input.deviceName,
      created_at: clock.now(), last_used_at: null,
    };
    db.$client
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_name, created_at, last_used_at)
         VALUES (@id, @user_id, @endpoint, @p256dh, @auth, @device_name, @created_at, @last_used_at)`,
      )
      .run(row);
    return toDto(row);
  })();
}

export function deleteSubscription(db: Db, userId: string, id: string): void {
  const res = db.$client.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw new HttpError(404, 'not_found');
}

// ---------- sending ----------

export type PushService = {
  readonly publicKey: string;
  /** Sends `payload` to all of the user's subscriptions; resolves to the number delivered. Never rejects. */
  sendToUser(ctx: Pick<ServiceCtx, 'db' | 'clock'>, userId: string, payload: PushPayload): Promise<number>;
  /** New pending request: one approval token per subscription of the device owner, then push. Never rejects. */
  notifyPending(ctx: Pick<ServiceCtx, 'db' | 'clock'>, requestId: string): Promise<number>;
  /** Deletes expired approval tokens. */
  prune(ctx: Pick<ServiceCtx, 'db' | 'clock'>): void;
};

export function createPushService(deps: { vapid: VapidKeys; subject: string; sender?: PushSender; logger?: ServiceLogger }): PushService {
  const sender = deps.sender ?? defaultPushSender;
  const opts: PushSendOptions = {
    vapidDetails: { subject: deps.subject, publicKey: deps.vapid.publicKey, privateKey: deps.vapid.privateKey },
    TTL: PUSH_TTL_SECONDS,
    urgency: 'high',
    timeout: PUSH_TIMEOUT_MS,
  };

  async function sendOne(ctx: Pick<ServiceCtx, 'db' | 'clock'>, sub: SubRow, payload: PushPayload): Promise<boolean> {
    if (!isAllowedPushEndpoint(sub.endpoint)) return false;
    try {
      await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), opts);
      ctx.db.$client.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?').run(ctx.clock.now(), sub.id);
      return true;
    } catch (err) {
      const statusCode = (err as { statusCode?: unknown })?.statusCode;
      try {
        // Gone / unknown at the push service: the browser unsubscribed.
        if (statusCode === 404 || statusCode === 410) ctx.db.$client.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } catch {
        // ignore
      }
      deps.logger?.error({ errName: (err as Error)?.name, statusCode: typeof statusCode === 'number' ? statusCode : undefined }, 'push send failed');
      return false;
    }
  }

  const subsOf = (ctx: Pick<ServiceCtx, 'db'>, userId: string) =>
    ctx.db.$client.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id').all(userId) as SubRow[];

  const count = async (sends: Promise<boolean>[]) => (await Promise.all(sends)).filter(Boolean).length;

  return {
    publicKey: deps.vapid.publicKey,

    async sendToUser(ctx, userId, payload) {
      try {
        return await count(subsOf(ctx, userId).map((s) => sendOne(ctx, s, payload)));
      } catch (err) {
        deps.logger?.error({ errName: (err as Error)?.name }, 'push send failed');
        return 0;
      }
    },

    async notifyPending(ctx, requestId) {
      try {
        const req = ctx.db.$client
          .prepare(
            `SELECT r.user_id, r.status, r.expires_at, u.disabled_at
               FROM access_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
          )
          .get(requestId) as { user_id: string | null; status: string; expires_at: number; disabled_at: number | null } | undefined;
        if (!req || req.status !== 'pending' || !req.user_id || req.disabled_at !== null) return 0;
        const userId = req.user_id;
        const now = ctx.clock.now();
        const insert = ctx.db.$client.prepare(
          `INSERT INTO approve_tokens (token_hash, request_id, user_id, subscription_id, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        );
        const sends = subsOf(ctx, userId).map((sub) => {
          const token = randomBytes(32).toString('base64url');
          insert.run(hashApproveToken(token), requestId, userId, sub.id, req.expires_at, now);
          return sendOne(ctx, sub, pendingPayload(token, requestId));
        });
        return await count(sends);
      } catch (err) {
        deps.logger?.error({ errName: (err as Error)?.name }, 'push notify failed');
        return 0;
      }
    },

    prune(ctx) {
      ctx.db.$client.prepare('DELETE FROM approve_tokens WHERE expires_at <= ?').run(ctx.clock.now());
    },
  };
}
