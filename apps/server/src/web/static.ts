import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Default location of the built web UI (apps/web/dist), relative to apps/server/{src,dist}. */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));

export const WEB_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Path prefixes owned by the server; unknown paths below them stay JSON 404s instead of the SPA. */
const SERVER_PREFIXES = ['/api', '/oauth', '/.well-known', '/mcp', '/healthz'];

const isServerPath = (path: string) => SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

const HTML_HEADERS: Record<string, string> = {
  'content-security-policy': WEB_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

/**
 * Serves the built SPA: hashed files under /assets with a long immutable cache, everything else no-cache,
 * and index.html (with CSP and security headers) for every other GET outside the server prefixes.
 * Does nothing when the dist folder has no index.html (dev, tests).
 */
export async function registerWebStatic(app: FastifyInstance, opts: { distDir: string }): Promise<void> {
  const { distDir } = opts;
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    app.log.info('web UI build not found; static serving disabled');
    return;
  }
  const indexHtml = readFileSync(indexPath);

  await app.register(fastifyStatic, {
    root: distDir,
    wildcard: false,
    index: false,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        for (const [k, v] of Object.entries(HTML_HEADERS)) res.setHeader(k, v);
        return;
      }
      res.setHeader('x-content-type-options', 'nosniff');
      const rel = filePath.slice(distDir.length).replaceAll('\\', '/');
      res.setHeader('cache-control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  const sendIndex = (reply: FastifyReply) => {
    return reply.headers(HTML_HEADERS).type('text/html; charset=utf-8').send(indexHtml);
  };

  app.get('/', (_req, reply) => sendIndex(reply));
  app.get('/*', (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (isServerPath(path) || path.startsWith('/assets/')) return reply.callNotFound();
    return sendIndex(reply);
  });
}
