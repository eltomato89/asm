import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { systemClock } from './clock.js';
import { openDb } from './db/client.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'asm.db'));
  const app = await buildApp({ config, db, clock: systemClock });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : err);
  process.exit(1);
});
