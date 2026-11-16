import type { FastifyInstance } from 'fastify';
import { AutoModeInputSchema, DecisionSchema } from '@asm/shared';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { HttpError } from '../errors.js';
import { reqInfo } from '../secrets/routes.js';
import { disableAutoMode, enableAutoMode, getAutoMode } from './automode.js';
import type { RequestEvent } from './events.js';
import { decideRequest, listRequests } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const listQuery = z.object({ status: z.enum(['pending', 'all']).default('pending') });
const decisionBody = z.strictObject({ decision: DecisionSchema });

export const SSE_HEARTBEAT_MS = 25_000;
export const MAX_STREAMS_PER_USER = 10;
const MAX_TIMER_MS = 2_147_483_647;

const sseFrame = (e: RequestEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;

export async function registerRequestRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;

  app.get('/api/requests', { preHandler: requireUser }, async (req) => {
    const { status } = listQuery.parse(req.query);
    return { items: listRequests(ctx, req.user!.id, status) };
  });

  // Deliberately no recent-auth: approvals must be one click.
  app.post('/api/requests/:id/decision', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { decision } = decisionBody.parse(req.body);
    return decideRequest(ctx, { requestId: id, userId: req.user!.id, decision }, reqInfo(req));
  });

  app.get('/api/automode', { preHandler: requireUser }, async (req) => getAutoMode(ctx, req.user!.id));

  app.put('/api/automode', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const body = AutoModeInputSchema.parse(req.body ?? {});
    const userId = req.user!.id;
    const minutes = body.minutes ?? getAutoMode(ctx, userId).defaultDurationMin;
    return enableAutoMode(ctx, userId, minutes, body.vaultIds, reqInfo(req));
  });

  app.delete('/api/automode', { preHandler: requireUser }, async (req) => disableAutoMode(ctx, req.user!.id, reqInfo(req)));

  // ---------- SSE ----------
  const streamsPerUser = new Map<string, number>();
  const openStreams = new Set<() => void>();

  // preClose: end hijacked streams before the server waits for open connections.
  app.addHook('preClose', async () => {
    for (const close of [...openStreams]) close();
  });

  app.get('/api/events', { preHandler: requireUser }, async (req, reply) => {
    const userId = req.user!.id;
    const sessionId = req.session!.id;
    const count = streamsPerUser.get(userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) throw new HttpError(429, 'too_many_streams');
    streamsPerUser.set(userId, count + 1);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    // The stream lives only as long as its session: re-validated before every write, capped at session expiry.
    const sessionValid = () =>
      ctx.db.$client.prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?').get(sessionId, userId, clock.now()) !== undefined;
    const send = (chunk: string) => {
      if (!sessionValid()) close();
      else res.write(chunk);
    };
    const unsubscribe = ctx.events.subscribe(userId, (e) => send(sseFrame(e)));
    const heartbeat = setInterval(() => send(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const lifetime = setTimeout(() => close(), Math.min(Math.max(req.session!.expiresAt - clock.now(), 0), MAX_TIMER_MS));
    lifetime.unref();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      openStreams.delete(close);
      const n = (streamsPerUser.get(userId) ?? 1) - 1;
      if (n <= 0) streamsPerUser.delete(userId);
      else streamsPerUser.set(userId, n);
      if (!res.writableEnded) res.end();
    };
    openStreams.add(close);
    res.on('close', close);
    res.on('error', close);
  });
}
