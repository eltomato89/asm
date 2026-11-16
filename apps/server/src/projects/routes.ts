import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { getProject, listProjects, mergeProjects, projectsForSecret } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const mergeBody = z.strictObject({ into: z.string().min(1).max(100) });

export async function registerProjectRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;

  app.get('/api/projects', { preHandler: requireUser }, async (req) => ({ items: listProjects(ctx.db, req.user!.id) }));

  app.get('/api/projects/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return getProject(ctx.db, req.user!.id, id);
  });

  app.post('/api/projects/:id/merge', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    return mergeProjects(ctx, req.user!.id, id, mergeBody.parse(req.body).into);
  });

  app.get('/api/secrets/:id/projects', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return { items: projectsForSecret(ctx.db, req.user!.id, id) };
  });
}
