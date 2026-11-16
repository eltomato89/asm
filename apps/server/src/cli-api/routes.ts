import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  ArchiveInputSchema,
  DescriptionSchema,
  EnvNameSchema,
  GenerateSchema,
  ProjectNameSchema,
  ReasonSchema,
  SecretCreateSchema,
  SecretValueSchema,
  TagsSchema,
  TitleSchema,
  type AccessRequestDto,
} from '@asm/shared';
import { z } from 'zod';
import { rateLimitOpts, type ModuleDeps } from '../app.js';
import { appendAudit } from '../audit/audit.js';
import type { Actor } from '../context.js';
import { HttpError, ValidationError } from '../errors.js';
import { bearerAuth, type DeviceIdentity } from '../oauth/bearer.js';
import { touchProject } from '../projects/service.js';
import { grantIdForRequest, redeemGrant } from '../requests/grants.js';
import { createRequest, createUpdateRequest, MAX_WAIT_MS, waitForRequest } from '../requests/service.js';
import { reqInfo } from '../secrets/routes.js';
import { archiveSecret, createSecret, searchSecrets } from '../secrets/service.js';

/** Long-poll of GET /api/cli/requests/:id/wait: below common client/proxy timeouts. */
export const CLI_WAIT_MAX_MS = Math.min(MAX_WAIT_MS, 50_000);
export const CLI_RATE_LIMIT_PER_MIN = 120;

const idParams = z.object({ id: z.string().min(1).max(100) });
const redeemBody = z.object({ hostname: z.string().max(255).optional() }).optional();
const requestBody = z.strictObject({ secretId: z.string().min(1).max(100), project: ProjectNameSchema, reason: ReasonSchema });
const waitQuery = z.object({ timeoutMs: z.coerce.number().int().min(0).max(CLI_WAIT_MAX_MS).optional() });
const createBody = SecretCreateSchema.extend({ project: ProjectNameSchema, reason: ReasonSchema });
const updateBody = z.strictObject({
  project: ProjectNameSchema,
  reason: ReasonSchema,
  title: TitleSchema.optional(),
  description: DescriptionSchema.optional(),
  tags: TagsSchema.optional(),
  envName: EnvNameSchema.nullable().optional(),
  value: SecretValueSchema.optional(),
  generate: GenerateSchema.optional(),
});
const archiveBody = ArchiveInputSchema.extend({ project: ProjectNameSchema });
const searchQuery = z.object({
  q: z.string().max(500).default(''),
  project: ProjectNameSchema,
  vault: z.string().min(1).max(100).optional(),
  archived: z.enum(['true', 'false']).default('false'),
});

/** Keys a device may never set (only humans control plaintext delivery). */
const FORBIDDEN_KEYS = ['allowPlaintextToAgent', 'allow_plaintext_to_agent'];
const rejectForbiddenKeys = (body: unknown) => {
  if (body && typeof body === 'object' && FORBIDDEN_KEYS.some((k) => Object.hasOwn(body, k))) throw new ValidationError('field_not_allowed');
};

const deviceActor = (d: DeviceIdentity): Actor => ({ type: 'device', deviceId: d.id, userId: d.userId });

/** CLI tokens only: MCP devices act as agents via /mcp and never redeem grants or use this API. */
async function requireCliDevice(req: FastifyRequest): Promise<void> {
  if (req.device?.kind !== 'cli') throw new HttpError(403, 'forbidden_device_kind');
}

/**
 * Bearer API of the `asm` CLI (device kind `cli`): grant redemption and request/secret operations without an agent.
 * JSON only, no cookies (so the session Origin hook does not apply).
 */
export async function registerCliRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, config } = deps;
  // preHandler hook: runs after bearerAuth so the limit is keyed by device.
  await app.register(rateLimit, { ...rateLimitOpts, hook: 'preHandler' });
  const opts = {
    preHandler: [bearerAuth({ db: ctx.db, clock: ctx.clock, publicOrigin: config.publicUrl.origin }), requireCliDevice],
    config: {
      rateLimit: { max: CLI_RATE_LIMIT_PER_MIN, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.device?.id ?? req.ip },
    },
  };

  /** Request DTO plus its outcome for the CLI: grantId (approved read) or version (approved update). */
  const withOutcome = (dto: AccessRequestDto, device: DeviceIdentity) => {
    if (dto.status !== 'approved') return dto;
    if (dto.kind === 'update') {
      const row = ctx.db.$client.prepare('SELECT current_version FROM secrets WHERE id = ?').get(dto.secret.id) as { current_version: number } | undefined;
      return { ...dto, version: row?.current_version ?? null };
    }
    const grantId = grantIdForRequest(ctx.db, dto.id, device.id);
    return grantId ? { ...dto, grantId } : dto;
  };

  app.post('/api/grants/:id/redeem', opts, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = redeemBody.parse(req.body ?? undefined);
    const { secretId, envName, value } = redeemGrant(ctx, { grantId: id, device: req.device! }, { ...reqInfo(req), hostname: body?.hostname });
    return reply.header('cache-control', 'no-store').send({ secrets: [{ secretId, envName, value }] });
  });

  app.post('/api/cli/requests', opts, async (req, reply) => {
    const body = requestBody.parse(req.body);
    const device = req.device!;
    const dto = createRequest(ctx, { device, ...body, delivery: 'cli' }, reqInfo(req));
    return reply.status(201).send(withOutcome(dto, device));
  });

  app.get('/api/cli/requests/:id/wait', opts, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { timeoutMs } = waitQuery.parse(req.query);
    const device = req.device!;
    const abort = new AbortController();
    // Ends the long-poll when the client disconnects (ServerResponse 'close' before the response finished).
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.on('close', onClose);
    try {
      return withOutcome(await waitForRequest(ctx, id, device.id, timeoutMs ?? CLI_WAIT_MAX_MS, abort.signal), device);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new HttpError(499, 'aborted');
      throw err;
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.post('/api/cli/secrets', opts, async (req, reply) => {
    rejectForbiddenKeys(req.body);
    const body = createBody.parse(req.body);
    const meta = createSecret(ctx, deviceActor(req.device!), body, reqInfo(req));
    return reply.status(201).send({ secretId: meta.id, version: 1 });
  });

  app.post('/api/cli/secrets/:id/update', opts, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    rejectForbiddenKeys(req.body);
    const { project, reason, value, generate, ...meta } = updateBody.parse(req.body);
    const device = req.device!;
    const dto = createUpdateRequest(ctx, { device, secretId: id, project, reason, meta, value, generate }, reqInfo(req));
    return reply.status(201).send(withOutcome(dto, device));
  });

  app.post('/api/cli/secrets/:id/archive', opts, async (req) => {
    const { id } = idParams.parse(req.params);
    return archiveSecret(ctx, deviceActor(req.device!), id, archiveBody.parse(req.body), reqInfo(req));
  });

  app.get('/api/cli/secrets', opts, async (req) => {
    const q = searchQuery.parse(req.query);
    const device = req.device!;
    const project = touchProject(ctx, q.project);
    const items = searchSecrets(ctx.db, device.userId, q.q, { vaultId: q.vault, includeArchived: q.archived === 'true' });
    appendAudit(ctx.db, ctx.clock, {
      actorType: 'device', actorId: device.id, deviceId: device.id, event: 'secret.searched', project: project.slug, ip: req.ip,
      meta: { query: q.q },
    });
    return { items };
  });
}
