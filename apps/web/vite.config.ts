import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.ASM_DEV_SERVER ?? 'http://localhost:8080';
const proxied = ['/api', '/oauth', '/.well-known', '/mcp'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
