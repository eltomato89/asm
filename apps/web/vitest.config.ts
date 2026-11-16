import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Playwright specs run via `pnpm e2e`, not in the unit test run.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
