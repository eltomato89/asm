// Starts the built server (apps/server/dist/main.js) with the temp data dir from the config and tees its log to
// ASM_E2E_LOG_FILE, where the specs read the one-time setup token from the „ASM setup token: …“ line.
// Plain JS on purpose: runs with any Node 22 without type stripping. Configured via env by playwright.config.ts.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { ASM_DATA_DIR: dataDir, ASM_E2E_LOG_FILE: logFile } = process.env;
if (!dataDir || !logFile) throw new Error('ASM_DATA_DIR and ASM_E2E_LOG_FILE are required');
mkdirSync(dataDir, { recursive: true });
const log = createWriteStream(logFile);

const main = fileURLToPath(new URL('../../server/dist/main.js', import.meta.url));
const child = spawn(process.execPath, [main], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
}
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  log.end();
  rmSync(dataDir, { recursive: true, force: true }); // temp dir holds the test DB and log
  process.exit(code ?? 0);
});
