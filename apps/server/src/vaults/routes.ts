import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireUser } from '../auth/guards.js';
import { reqInfo } from '../secrets/routes.js';
import { addMember, createVault, listVaultsForUser, removeMember } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const createBody = z.strictObject({ name: z.string().trim().min(1).max(200) });
const addBody = z.strictObject({ username: z.string().min(1).max(64), role: z.enum(['owner', 'member']).optional() });
const removeBody = z.strictObject({ userId: z.string().min(1).max(100) });

export async function registerVaultRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx } = deps;

  app.get('/api/vaults', { preHandler: requireUser }, async (req) => ({ items: listVaultsForUser(ctx.db, req.user!.id) }));

  app.post('/api/vaults', { preHandler: requireUser }, async (req, reply) => {
    const { name } = createBody.parse(req.body);
    return reply.status(201).send(createVault(ctx, req.user!.id, name));
  });

  app.post('/api/vaults/:id/members', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return addMember(ctx, req.user!.id, id, addBody.parse(req.body), reqInfo(req));
  });

  app.delete('/api/vaults/:id/members', { preHandler: requireUser }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const vault = removeMember(ctx, req.user!.id, id, removeBody.parse(req.body).userId, reqInfo(req));
    return vault ?? reply.status(204).send();
  });
}
