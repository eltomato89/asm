import type { Command } from 'commander';
import { serverHost, type Runtime } from '../runtime.js';

export function registerLogout(program: Command, rt: () => Runtime): void {
  program
    .command('logout')
    .description('Delete the stored tokens for the server')
    .action(async () => {
      const r = rt();
      const server = r.server();
      const deleted = await r.store.delete(serverHost(server));
      r.stderr.write(deleted ? `Logged out of ${server}\n` : `Not logged in to ${server}\n`);
    });
}
