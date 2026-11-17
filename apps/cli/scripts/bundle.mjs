#!/usr/bin/env node
// Bundles the CLI (incl. @asm/shared, commander, zod, …) into one ESM file: dist-bundle/asm.mjs + manifest asm.json,
// plus dist-bundle/THIRD_PARTY_NOTICES for the bundled third-party packages (from the esbuild metafile inputs).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { collectFromFiles, writeNotices } from '../../../scripts/third-party-notices.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'asm.mjs');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const sharedSrc = join(root, '../../packages/shared/src');
/** @type {import('esbuild').Plugin} */
const sharedFromSource = {
  name: 'asm-shared-from-source',
  setup(b) {
    b.onResolve({ filter: /^@asm\/shared(\/[a-z-]+)?$/ }, (args) => {
      const sub = args.path.slice('@asm/shared'.length).replace(/^\//, '') || 'index';
      const path = join(sharedSrc, `${sub}.ts`);
      if (!existsSync(path)) return { errors: [{ text: `unknown @asm/shared entry: ${args.path}` }] };
      return { path };
    });
  },
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve the workspace package @asm/shared to its TypeScript sources (no prior build needed); every other
  // dependency resolves normally (no 'development' condition for third-party packages).
  plugins: [sharedFromSource],
  define: { __ASM_VERSION__: JSON.stringify(version) },
  // src/index.ts already starts with the shebang (esbuild keeps it on the first line).
  // CommonJS dependencies (commander) call require() for Node built-ins; ESM output needs a real require.
  banner: { js: "// ASM CLI. Copyright 2026 Jens Köhler. SPDX-License-Identifier: Apache-2.0\n// Includes third-party software; licenses: THIRD_PARTY_NOTICES next to this file, or <server>/cli/THIRD_PARTY_NOTICES.\nimport { createRequire as __asmCreateRequire } from 'node:module';\nconst require = __asmCreateRequire(import.meta.url);" },
  legalComments: 'none',
  minify: false,
  logLevel: 'warning',
  metafile: true,
});

const native = Object.keys(result.metafile.inputs).filter((p) => p.endsWith('.node') || /keyring|napi/i.test(p));
if (native.length > 0) {
  console.error(`bundle contains native modules: ${native.join(', ')}`);
  process.exit(1);
}

const data = readFileSync(outFile);
if (!data.toString('utf8', 0, 20).startsWith('#!/usr/bin/env node')) {
  console.error('bundle is missing the shebang');
  process.exit(1);
}
chmodSync(outFile, 0o755);
// legalComments is 'none': the license texts of everything bundled ship in this file instead.
const noticeCount = writeNotices(
  join(outDir, 'THIRD_PARTY_NOTICES'),
  `asm CLI ${version} (asm.mjs)`,
  collectFromFiles(Object.keys(result.metafile.inputs)),
);
const manifest = { version, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
writeFileSync(join(outDir, 'asm.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`dist-bundle/asm.mjs ${manifest.size} bytes, version ${version}, sha256 ${manifest.sha256}; THIRD_PARTY_NOTICES: ${noticeCount} packages`);
