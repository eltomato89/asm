import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeviceDefaultVaultInputSchema, StandingApprovalInputSchema } from '@asm/shared';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { reqInfo } from '../secrets/routes.js';
import { getStandingApproval, removeStandingApproval, setStandingApproval } from '../standing/service.js';
import { listDevices, renameDevice, revokeOwnDevice, setDeviceDefaultVault } from './service.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const renameBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

export async function registerDeviceRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;

  app.get('/api/devices', { preHandler: requireUser }, async (req) => ({ items: listDevices(ctx, req.user!.id) }));

  app.patch('/api/devices/:id', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return renameDevice(ctx, req.user!.id, id, renameBody.parse(req.body).name);
  });

  app.post('/api/devices/:id/revoke', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    return revokeOwnDevice(ctx, req.user!.id, id, reqInfo(req));
  });

  // Can widen what a standing approval with includeCreated auto-approves: needs a recent login. Owner only (others 404).
  app.put('/api/devices/:id/default-vault', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { vaultId } = DeviceDefaultVaultInputSchema.parse(req.body ?? {});
    return setDeviceDefaultVault(ctx, req.user!.id, id, vaultId, reqInfo(req));
  });

  // ---------- standing approval (owner only; others get 404) ----------
  app.get('/api/devices/:id/standing-approval', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return getStandingApproval(ctx, req.user!.id, id);
  });

  // Widens rights: needs a recent login. Full replace; a ZodError (incl. the empty_list refine) maps to 400 invalid_request.
  app.put('/api/devices/:id/standing-approval', { preHandler: [requireUser, requireRecentAuth(clock)] }, async (req) => {
    const { id } = idParams.parse(req.params);
    const input = StandingApprovalInputSchema.parse(req.body ?? {});
    return setStandingApproval(ctx, req.user!.id, id, input, reqInfo(req));
  });

  // Reduces rights: no re-auth.
  app.delete('/api/devices/:id/standing-approval', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    return removeStandingApproval(ctx, req.user!.id, id, reqInfo(req));
  });
}
