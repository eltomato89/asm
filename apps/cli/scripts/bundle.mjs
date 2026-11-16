#!/usr/bin/env node
// Bundles the CLI (incl. @asm/shared, commander, zod, …) into one ESM file: dist-bundle/asm.mjs + manifest asm.json.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'asm.mjs');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve workspace packages (@asm/shared) to their TypeScript sources.
  conditions: ['development'],
  define: { __ASM_VERSION__: JSON.stringify(version) },
  // src/index.ts already starts with the shebang (esbuild keeps it on the first line).
  // CommonJS dependencies (commander) call require() for Node built-ins; ESM output needs a real require.
  banner: { js: "import { createRequire as __asmCreateRequire } from 'node:module';\nconst require = __asmCreateRequire(import.meta.url);" },
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
const manifest = { version, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
writeFileSync(join(outDir, 'asm.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`dist-bundle/asm.mjs ${manifest.size} bytes, version ${version}, sha256 ${manifest.sha256}`);
