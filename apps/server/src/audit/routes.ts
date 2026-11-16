import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModuleDeps } from '../app.js';
import { requireAdmin, requireUser } from '../auth/guards.js';
import { queryAudit, verifyChain, type AuditFilter, type AuditRow } from './audit.js';

const filterQuery = z.object({
  deviceId: z.string().max(100).optional(),
  secretId: z.string().max(100).optional(),
  project: z.string().max(200).optional(),
  event: z.string().max(100).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  cursor: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const CSV_MAX_ROWS = 10_000;
const CSV_PAGE = 200;
const CSV_COLUMNS = ['seq', 'id', 'ts', 'actor_type', 'actor_id', 'event', 'secret_id', 'vault_id', 'device_id', 'project', 'reason', 'ip', 'meta'];

/** RFC 4180 cell with spreadsheet formula-injection guard. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(r: AuditRow): string {
  return [
    r.seq, r.id, new Date(r.ts).toISOString(), r.actorType, r.actorId, r.event, r.secretId, r.vaultId, r.deviceId,
    r.project, r.reason, r.ip, r.meta === null ? null : JSON.stringify(r.meta),
  ].map(csvCell).join(',');
}

export async function registerAuditRoutes(app: FastifyInstance, deps: ModuleDeps): Promise<void> {
  const { db } = deps.ctx;
  const filterOf = (req: { query: unknown; user?: { id: string; isAdmin: boolean } }): AuditFilter => ({
    ...filterQuery.parse(req.query),
    userId: req.user!.id,
    includeSystem: req.user!.isAdmin,
  });

  app.get('/api/audit', { preHandler: requireUser }, async (req) => queryAudit(db, filterOf(req)));

  app.get('/api/audit.csv', { preHandler: requireUser }, async (req, reply) => {
    const filter = filterOf(req);
    const lines = [CSV_COLUMNS.join(',')];
    let cursor = filter.cursor;
    let count = 0;
    let truncated = false;
    for (;;) {
      const page = queryAudit(db, { ...filter, cursor, limit: Math.min(CSV_PAGE, CSV_MAX_ROWS - count) });
      for (const r of page.items) lines.push(csvLine(r));
      count += page.items.length;
      if (!page.nextCursor) break;
      if (count >= CSV_MAX_ROWS) {
        truncated = true;
        break;
      }
      cursor = page.nextCursor;
    }
    if (truncated) reply.header('x-truncated', 'true');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit.csv"')
      .send(`${lines.join('\r\n')}\r\n`);
  });

  app.get('/api/audit/verify', { preHandler: requireAdmin }, async () => verifyChain(db));
}
