import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';
import { renderInstallScript } from './install-script.js';

export type CliManifest = { version: string; sha256: string; size: number };

export type CliDistOpts = {
  /** Directory holding asm.mjs + asm.json; null = no bundle (dev/tests). */
  cliDir: string | null;
  /** Server origin embedded into install.sh. */
  origin: string;
};

const notAvailable = () => new HttpError(404, 'cli_not_available');

function parseManifest(raw: string): CliManifest | null {
  try {
    const m = JSON.parse(raw) as Partial<CliManifest>;
    if (typeof m.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return null;
    if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
    if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 0) return null;
    return { version: m.version, sha256: m.sha256, size: m.size };
  } catch {
    return null;
  }
}

/** Reads the manifest at request time (the bundle can be rebuilt without restarting the server). */
async function loadManifest(cliDir: string | null): Promise<CliManifest> {
  if (!cliDir) throw notAvailable();
  const raw = await readFile(join(cliDir, 'asm.json'), 'utf8').catch(() => null);
  const manifest = raw === null ? null : parseManifest(raw);
  if (!manifest) throw notAvailable();
  return manifest;
}

/** If-None-Match matching (weak comparison, RFC 9110 §13.1.2). */
function matchesEtag(req: FastifyRequest, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

/**
 * Public CLI distribution (no auth: the CLI is not secret):
 * GET /cli/install.sh (installer with the server origin baked in), /cli/asm.mjs (bundle), /cli/asm.json (manifest).
 */
export async function registerCliDistRoutes(app: FastifyInstance, opts: CliDistOpts): Promise<void> {
  const { cliDir } = opts;
  // loadConfig already validated the origin (SAFE_ORIGIN); renderInstallScript re-checks as defense in depth.
  const script = renderInstallScript(opts.origin);

  app.get('/cli/install.sh', async (_req, reply) => {
    await loadManifest(cliDir);
    return reply
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .type('text/x-shellscript; charset=utf-8')
      .send(script);
  });

  app.get('/cli/asm.json', async (_req, reply) => {
    const manifest = await loadManifest(cliDir);
    return reply.header('cache-control', 'no-cache').header('x-content-type-options', 'nosniff').send(manifest);
  });

  app.get('/cli/asm.mjs', async (req, reply) => {
    const manifest = await loadManifest(cliDir);
    const etag = `"${manifest.sha256}"`;
    reply
      .header('etag', etag)
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff');
    const bundlePath = join(cliDir as string, 'asm.mjs');
    if (matchesEtag(req, etag)) {
      // Only confirm the client's copy if we could actually serve the bundle.
      if (!(await access(bundlePath).then(() => true, () => false))) throw notAvailable();
      return reply.status(304).send();
    }
    const body = await readFile(bundlePath).catch(() => null);
    if (!body) throw notAvailable();
    return reply.type('text/javascript; charset=utf-8').send(body);
  });
}
