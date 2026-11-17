import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { collectFromFiles, renderNotices } from '../../scripts/third-party-notices.mjs';

/** Directory of an installed package, resolved from `from` (a file or directory path). */
function packageDir(name: string, from: string): string {
  return dirname(createRequire(join(from, 'noop.js')).resolve(`${name}/package.json`));
}

/**
 * Emits THIRD_PARTY_NOTICES.txt listing every third-party package with a module in the build graph (JS, CSS and
 * asset sources such as the @fontsource font files), plus build-tool code that lands in the output (Vite's
 * modulepreload polyfill, the Rolldown runtime, Tailwind's preflight CSS), with the full license texts.
 */
function thirdPartyNotices(): Plugin {
  const here = import.meta.dirname;
  return {
    name: 'asm-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = new Set<string>(this.getModuleIds());
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') for (const id of out.moduleIds) files.add(id);
        else for (const name of out.originalFileNames ?? []) files.add(name);
      }
      const dirs: string[] = [];
      const ids = [...files];
      const viteDir = packageDir('vite', here);
      if (ids.some((id) => id.startsWith('\0vite/'))) dirs.push(viteDir);
      if (ids.some((id) => id.startsWith('\0rolldown/'))) dirs.push(packageDir('rolldown', viteDir));
      const css = Object.values(bundle).filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
      if (css.some((o) => o.type === 'asset' && String(o.source).includes('tailwindcss v'))) dirs.push(packageDir('tailwindcss', here));
      const packages = collectFromFiles([...ids, ...dirs.map((d) => join(d, 'package.json'))], here);
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: renderNotices('Agent Secrets Manager web UI', packages) });
    },
  };
}

const server = process.env.ASM_DEV_SERVER ?? 'http://localhost:8080';
const proxied = ['/api', '/oauth', '/.well-known', '/mcp'];

export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyNotices()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: server, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Long-lived vendor chunk: app updates do not invalidate the framework code in caches.
        // One vendor chunk (splitting React from libraries that import it causes init-order cycles).
        codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] },
      },
    },
  },
});
