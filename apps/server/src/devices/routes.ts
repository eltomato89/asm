import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { reqInfo } from '../secrets/routes.js';
import { listDevices, renameDevice, revokeOwnDevice } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const renameBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

export async function registerDeviceRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;

  app.get('/api/devices', { preHandler: requireUser }, async (req) => ({ items: listDevices(ctx.db, req.user!.id) }));

  app.patch('/api/devices/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return renameDevice(ctx, req.user!.id, id, renameBody.parse(req.body).name);
  });

  app.post('/api/devices/:id/revoke', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    return revokeOwnDevice(ctx, req.user!.id, id, reqInfo(req));
  });
}
