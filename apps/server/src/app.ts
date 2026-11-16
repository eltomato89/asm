import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { installAuthContext } from './auth/guards.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createSetupState, type SetupState } from './auth/setup.js';
import type { WebAuthnAdapter } from './auth/webauthn.js';
import { installErrorHandler } from './errors.js';
import cookie from '@fastify/cookie';
import { registerAuditRoutes } from './audit/routes.js';
import { createServiceCtx, type ServiceCtx, type ServiceHooks } from './context.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerSecretRoutes } from './secrets/routes.js';
import { registerVaultRoutes } from './vaults/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    setup: SetupState;
  }
}

export type AppDeps = {
  config: Config;
  db: Db;
  clock: Clock;
  logger?: Logger;
  webauthn?: WebAuthnAdapter;
  /** Cross-module service hooks (defaults are no-ops; Task 9 wires the real ones). */
  hooks?: ServiceHooks;
};

/** Deps passed to domain route modules. */
export type ModuleDeps = AppDeps & { ctx: ServiceCtx };

const REDACT_KEYS = ['value', 'plaintext', 'password', 'token', 'authorization', 'cookie'];
const MAX_REDACT_DEPTH = 6;

// pino wildcards match exactly one level each, so enumerate: key, *.key, *.*.key, ...
export const REDACT_PATHS = [
  ...REDACT_KEYS.flatMap((k) =>
    Array.from({ length: MAX_REDACT_DEPTH }, (_, depth) => [...Array<string>(depth).fill('*'), k].join('.')),
  ),
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
  const root = app as unknown as FastifyInstance;
  installErrorHandler(root);
  root.decorate('setup', createSetupState(deps.db, root.log));
  await root.register(cookie);
  installAuthContext(root, { db: deps.db, clock: deps.clock, publicOrigin: deps.config.publicUrl.origin });
  await root.register(registerAuthRoutes, deps);
  const ctx = createServiceCtx({ db: deps.db, clock: deps.clock, kek: deps.config.masterKey, hooks: deps.hooks });
  const moduleDeps: ModuleDeps = { ...deps, ctx };
  await root.register(registerVaultRoutes, moduleDeps);
  await root.register(registerSecretRoutes, moduleDeps);
  await root.register(registerProjectRoutes, moduleDeps);
  await root.register(registerAuditRoutes, moduleDeps);
  root.get('/healthz', async () => ({ status: 'ok' }));
  return root;
}
