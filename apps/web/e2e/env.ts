import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared by playwright.config.ts and the specs. The data dir is created once with mkdtemp in the runner process
 * (which loads the config first) and handed to the web server and the workers via ASM_E2E_DATA_DIR.
 */
export const E2E_PORT = Number(process.env.ASM_E2E_PORT ?? 18765);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
process.env.ASM_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'asm-e2e-'));
export const E2E_DATA_DIR = process.env.ASM_E2E_DATA_DIR;
/** Server log (stdout/stderr), where the specs find the one-time setup token. */
export const E2E_LOG_FILE = join(E2E_DATA_DIR, 'server.log');
/** Fixed test-only master key (32 bytes of 0x07). */
export const E2E_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

export const ADMIN = { username: 'admin', password: 'e2e-password-123' };
/** Signed-in admin session saved by the setup project; specs that just need a logged-in admin start from it. */
export const ADMIN_STATE = fileURLToPath(new URL('./.auth/admin.json', import.meta.url));
