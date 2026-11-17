import { defineConfig } from 'vitest/config';

// Root entry point for `vitest` run from the repository root (e.g. IDE integrations).
// Each package keeps its own `vitest run` script, which `pnpm -r test` uses; this
// replaces the removed `vitest.workspace.ts` with the `test.projects` option.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
