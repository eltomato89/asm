import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Shared by playwright.config.ts, the server launcher and the specs (each evaluates it in its own process). */
export const E2E_PORT = Number(process.env.ASM_E2E_PORT ?? 18765);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
/** Deterministic so every Playwright worker finds the server log (setup token); wiped on each server start. */
export const E2E_DATA_DIR = join(tmpdir(), `asm-e2e-${E2E_PORT}`);
export const E2E_LOG_FILE = join(E2E_DATA_DIR, 'server.log');
/** Fixed test-only master key (32 bytes of 0x07). */
export const E2E_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

export const ADMIN = { username: 'admin', password: 'e2e-password-123' };
