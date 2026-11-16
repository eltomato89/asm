import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { buildApp, type AppDeps } from '../../src/app.js';
import { FakeClock } from '../../src/clock.js';
import type { Config } from '../../src/config.js';
import { openDb, type Db } from '../../src/db/client.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export async function createTestApp(
  opts: { dbPath?: string; config?: Partial<Config>; clock?: FakeClock; logger?: AppDeps['logger'] } = {},
): Promise<{ app: FastifyInstance; db: Db; clock: FakeClock; config: Config }> {
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
  const app = await buildApp({ config, db, clock, logger });
  return { app, db, clock, config };
}
