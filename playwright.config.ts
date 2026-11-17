import { defineConfig, devices } from '@playwright/test';
import { E2E_DATA_DIR, E2E_LOG_FILE, E2E_MASTER_KEY, E2E_ORIGIN, E2E_PORT } from './apps/web/e2e/env';

/**
 * End-to-end tests against the real built server (`pnpm e2e`). The web server builds everything once
 * (`pnpm build`) and starts `apps/server/dist/main.js` with a fresh temp data dir and a fixed test master key.
 * The `setup` project performs the first-admin setup in the UI; the spec projects depend only on it.
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  globalTeardown: './apps/web/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: { ...devices['Desktop Chrome'], baseURL: E2E_ORIGIN, locale: 'en-US', trace: 'retain-on-failure' },
  projects: [
    { name: 'setup', testMatch: 'admin.setup.ts' },
    { name: 'passkey', testMatch: 'passkey.spec.ts', dependencies: ['setup'] },
    { name: 'flow', testMatch: 'flow.spec.ts', dependencies: ['setup'] },
    { name: 'locale', testMatch: 'locale.spec.ts', dependencies: ['setup'] },
    { name: 'standing', testMatch: 'standing.spec.ts', dependencies: ['setup'] },
  ],
  webServer: {
    command: 'pnpm build && node apps/web/e2e/start-server.mjs',
    env: {
      ASM_PUBLIC_URL: E2E_ORIGIN,
      ASM_MASTER_KEY: E2E_MASTER_KEY,
      ASM_DATA_DIR: E2E_DATA_DIR,
      ASM_E2E_LOG_FILE: E2E_LOG_FILE,
      ASM_E2E_DATA_DIR: E2E_DATA_DIR,
      PORT: String(E2E_PORT),
    },
    url: `${E2E_ORIGIN}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
