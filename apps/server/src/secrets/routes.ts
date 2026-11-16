import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ArchiveInputSchema, SecretCreateSchema, SecretPatchSchema } from '@asm/shared';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import type { Actor, RequestInfo } from '../context.js';
import {
  applySecretChange,
  archiveSecret,
  createSecret,
  deleteSecret,
  getSecretMeta,
  listHistory,
  restoreVersion,
  revealSecret,
  searchSecrets,
  unarchiveSecret,
} from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const versionParams = idParams.extend({ v: z.coerce.number().int().min(1) });
const searchQuery = z.object({
  q: z.string().max(500).default(''),
  vault: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});

export const userActor = (req: FastifyRequest): Actor => ({ type: 'user', userId: req.user!.id });
export const reqInfo = (req: FastifyRequest): RequestInfo => ({ ip: req.ip });

export async function registerSecretRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;
  const recent = [requireUser, requireRecentAuth(clock)];

  app.get('/api/secrets', { preHandler: requireUser }, async (req) => {
    const q = searchQuery.parse(req.query);
    return { items: searchSecrets(ctx.db, req.user!.id, q.q, { vaultId: q.vault, status: q.status }) };
  });

  app.post('/api/secrets', { preHandler: requireUser }, async (req, reply) => {
    const body = SecretCreateSchema.parse(req.body);
    return reply.status(201).send(createSecret(ctx, userActor(req), body, reqInfo(req)));
  });

  app.get('/api/secrets/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return getSecretMeta(ctx.db, req.user!.id, id);
  });

  app.patch('/api/secrets/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { value, generate, project, reason, ...meta } = SecretPatchSchema.parse(req.body);
    return applySecretChange(ctx, userActor(req), id, { meta, value, generate, project, reason }, reqInfo(req));
  });

  app.delete('/api/secrets/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    deleteSecret(ctx, userActor(req), id, reqInfo(req));
    return { ok: true };
  });

  app.post('/api/secrets/:id/reveal', { preHandler: recent }, async (req) => {
    const { id } = idParams.parse(req.params);
    return { value: revealSecret(ctx, userActor(req), id, undefined, reqInfo(req)) };
  });

  app.get('/api/secrets/:id/versions', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return listHistory(ctx.db, req.user!.id, id);
  });

  app.post('/api/secrets/:id/versions/:v/reveal', { preHandler: recent }, async (req) => {
    const { id, v } = versionParams.parse(req.params);
    return { value: revealSecret(ctx, userActor(req), id, v, reqInfo(req)) };
  });

  app.post('/api/secrets/:id/versions/:v/restore', { preHandler: recent }, async (req) => {
    const { id, v } = versionParams.parse(req.params);
    return restoreVersion(ctx, userActor(req), id, v, reqInfo(req));
  });

  app.post('/api/secrets/:id/archive', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return archiveSecret(ctx, userActor(req), id, ArchiveInputSchema.parse(req.body ?? {}), reqInfo(req));
  });

  app.post('/api/secrets/:id/unarchive', { preHandler: recent }, async (req) => {
    const { id } = idParams.parse(req.params);
    return unarchiveSecret(ctx, userActor(req), id, reqInfo(req));
  });
}
