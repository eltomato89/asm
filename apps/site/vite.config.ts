import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// GitHub Pages serves the project page below /asm/. Override with SITE_BASE=/ for a custom domain or a
// local preview at the root.
export default defineConfig({
  base: process.env.SITE_BASE ?? '/asm/',
  plugins: [tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
