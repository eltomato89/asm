import type { FastifyInstance } from 'fastify';
import { StandingRequestDecisionInputSchema } from '@asm/shared';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireRecentAuth, requireUser } from '../auth/guards.js';
import { reqInfo } from '../secrets/routes.js';
import { decideStandingRequest, listStandingRequests } from './requests.js';

const idParams = z.object({ id: z.string().min(1).max(100) });
const listQuery = z.object({ status: z.enum(['pending', 'all']).default('pending') });

/** Agent-proposed standing approvals (owner only; others get 404). */
export async function registerStandingRequestRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { ctx, clock } = deps;

  app.get('/api/standing-requests', { preHandler: requireUser }, async (req) => {
    const { status } = listQuery.parse(req.query);
    return { items: listStandingRequests(ctx, req.user!.id, status) };
  });

  // Approving grants a long-lived standing approval: needs a recent login (401 reauth_required; the web client re-authenticates
  // and retries). Denying reduces nothing and needs none.
  const recentAuth = requireRecentAuth(clock);
  app.post('/api/standing-requests/:id/decision', { preHandler: requireUser }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { decision, settings } = StandingRequestDecisionInputSchema.parse(req.body ?? {});
    if (decision === 'approve') await recentAuth(req, reply);
    return decideStandingRequest(ctx, { id, userId: req.user!.id, decision, ...(settings ? { settings } : {}) }, reqInfo(req), {
      via: 'web',
    });
  });
}
