import { readFileSync } from 'node:fs';

/** Replaced with the package version by the bundler (scripts/bundle.mjs). */
declare const __ASM_VERSION__: string | undefined;

/** True when running from the single-file bundle (dist-bundle/asm.mjs). */
export const BUNDLED = typeof __ASM_VERSION__ !== 'undefined';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? `${pkg.version}-dev` : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION: string = typeof __ASM_VERSION__ !== 'undefined' ? __ASM_VERSION__ : packageVersion();
