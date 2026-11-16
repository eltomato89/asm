import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { buildApp, type AppDeps } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { openDb, type Db } from '../../src/db/client.js';
import { createServiceCtx, defaultHooks, type ServiceCtx } from '../../src/context.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export async function createTestApp(
  opts: { dbPath?: string; config?: Partial<Config>; clock?: FakeClock; logger?: AppDeps['logger']; webauthn?: AppDeps['webauthn'] } = {},
): Promise<{ app: FastifyInstance; db: Db; clock: FakeClock; config: Config; ctx: ServiceCtx }> {
  const clock = opts.clock ?? new FakeClock();
  const config: Config = {
    publicUrl: new URL('https://asm.test'),
    masterKey: TEST_KEY,
    trustProxy: false,
    autoModeMaxMin: 240,
    dataDir: ':memory:',
    port: 0,
    ...opts.config,
  };
  const db = openDb(opts.dbPath ?? ':memory:');
  const logger = opts.logger ?? pino({ level: 'silent' });
  // Shared hooks object: tests may swap hooks on ctx and the app's routes see the change.
  const hooks = { ...defaultHooks };
  const app = await buildApp({ config, db, clock, logger, webauthn: opts.webauthn, hooks });
  const ctx = createServiceCtx({ db, clock, kek: config.masterKey, hooks });
  return { app, db, clock, config, ctx };
}
