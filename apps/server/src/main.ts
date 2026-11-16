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

  // Graceful shutdown (docker stop sends SIGTERM): stop accepting requests, close hooks/timers, then the database.
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => {
        db.$client.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ errName: (err as Error)?.name }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : err);
  process.exit(1);
});
