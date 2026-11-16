import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';

export type AppDeps = { config: Config; db: Db; clock: Clock; logger?: Logger };

export const REDACT_PATHS = [
  '*.value',
  '*.plaintext',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } });
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger(),
    trustProxy: deps.config.trustProxy,
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  return app as unknown as FastifyInstance;
}
