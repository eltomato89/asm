import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { systemClock } from './clock.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Task 3 replaces this placeholder with openDb().
  const db = undefined as unknown as import('./db/client.js').Db;
  const app = await buildApp({ config, db, clock: systemClock });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : err);
  process.exit(1);
});
