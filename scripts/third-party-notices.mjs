#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES files (name, version, license id, full license/notice texts) for the third-party
// packages that are actually shipped. Dependency-free; used as a library by apps/cli/scripts/bundle.mjs (esbuild
// metafile inputs) and apps/web/vite.config.ts (Rolldown module ids), and as a CLI by the Dockerfile:
//
//   node scripts/third-party-notices.mjs combine --out FILE [--node-modules DIR --label NAME]... [--from FILE --label NAME]...
//
// --node-modules walks an installed node_modules tree (e.g. the `pnpm deploy` output of the server) and lists every
// package in it; --from merges entries of a notices file produced by this script. Entries are deduplicated by
// name@version. Workspace packages (@asm/*) are excluded. Fails loudly when a package lacks license information.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEPARATOR = '='.repeat(80);
const ENTRY_RE = new RegExp(`^${SEPARATOR}\\nPackage: `, 'm');
const LICENSE_FILE_RE = /^(licen[cs]e|copying|unlicense)([.\-_].*)?$/i;
const NOTICE_FILE_RE = /^notice([.\-_].*)?$/i;
const EXCLUDED_SCOPES = ['@asm/'];

const MIT_TEXT = `MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The full Apache License 2.0 text (this repository's own LICENSE). */
const apacheText = () => readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

/** Copyright holder from package.json `author` (name only). */
const holderOf = (pkg) => {
  const a = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return (a ?? '').replace(/\s*[<(].*$/, '').trim() || `the ${pkg.name} authors`;
};

/** Standard license texts, reproduced for packages that declare the license but ship no license file. */
const STANDARD_TEXTS = {
  MIT: (pkg) => MIT_TEXT.replace('{holder}', holderOf(pkg)),
  'Apache-2.0': () => apacheText(),
};

/**
 * Packages that ship no license file, reviewed by hand (declared license checked against package.json/README and
 * the upstream repository). The standard text of the declared license is reproduced for them. Any other package
 * without a license file fails the build.
 * @type {Record<string, keyof typeof STANDARD_TEXTS>}
 */
const MISSING_LICENSE_TEXT = {
  '@epic-web/invariant': 'MIT',
  'abstract-logging': 'MIT',
  'drizzle-orm': 'Apache-2.0',
  http_ece: 'MIT',
  'proxy-agent-negotiate': 'MIT',
  'react-remove-scroll-bar': 'MIT',
};

/** Package root for a file inside node_modules (the last node_modules segment wins), or null. */
export function packageRootOf(file) {
  const clean = file.replace(/^\0+/, '').replace(/[?#].*$/, '').replaceAll('\\', '/');
  const marker = '/node_modules/';
  const idx = clean.lastIndexOf(marker);
  if (idx < 0) return null;
  const rest = clean.slice(idx + marker.length).split('/');
  if (!rest[0] || rest[0].startsWith('.')) return null;
  const nameParts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  if (nameParts.length === 0 || nameParts.some((p) => !p)) return null;
  return clean.slice(0, idx + marker.length) + nameParts.join('/');
}

function licenseId(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (l && typeof l === 'object' && !Array.isArray(l) && typeof l.type === 'string') return l.type;
  if (Array.isArray(l) && l.length > 0) {
    const ids = l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean);
    if (ids.length > 0) return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`;
  }
  return null;
}

function readTexts(dir, re) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => (d.isFile() || d.isSymbolicLink()) && re.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), 'utf8').replace(/\r\n?/g, '\n').trim() }))
    .filter((t) => t.text.length > 0);
}

/** Reads name, version, license id and license/notice texts of the package in `dir`. Throws on missing info. */
export function readPackage(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`third-party notices: no package.json in ${dir}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.name || !pkg.version) throw new Error(`third-party notices: ${pkgPath} lacks name or version`);
  const license = licenseId(pkg);
  if (!license) throw new Error(`third-party notices: ${pkg.name}@${pkg.version} declares no license (${dir})`);
  let licenseTexts = readTexts(dir, LICENSE_FILE_RE);
  const noticeTexts = readTexts(dir, NOTICE_FILE_RE);
  if (licenseTexts.length === 0) {
    const reviewed = MISSING_LICENSE_TEXT[pkg.name];
    if (!reviewed || reviewed !== license) {
      throw new Error(
        `third-party notices: ${pkg.name}@${pkg.version} (${license}) ships no LICENSE/LICENCE/COPYING file (${dir}); ` +
          'review it and add it to MISSING_LICENSE_TEXT in scripts/third-party-notices.mjs',
      );
    }
    licenseTexts = [{ file: `${license} (standard text; the package ships no license file)`, text: STANDARD_TEXTS[reviewed](pkg).trim() }];
  }
  return {
    name: pkg.name,
    version: pkg.version,
    license,
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
    texts: [...licenseTexts, ...noticeTexts],
  };
}

const isExcluded = (name) => EXCLUDED_SCOPES.some((s) => name.startsWith(s));

/** Collects packages for a list of shipped module files (absolute paths or paths relative to `cwd`). */
export function collectFromFiles(files, cwd = process.cwd()) {
  const roots = new Set();
  for (const f of files) {
    const root = packageRootOf(f.startsWith('\0') ? f : resolve(cwd, f));
    if (root) roots.add(root);
  }
  return collectFromDirs(roots);
}

/** Collects packages from package directories, deduplicated by name@version and sorted. */
export function collectFromDirs(dirs) {
  const byKey = new Map();
  const errors = [];
  for (const dir of dirs) {
    try {
      const p = readPackage(dir);
      if (!isExcluded(p.name)) byKey.set(`${p.name}@${p.version}`, p);
    } catch (err) {
      // Workspace packages may lack license files; everything else must have them. Report all problems at once.
      const name = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name : '';
      if (!isExcluded(name ?? '')) errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) throw new Error([...new Set(errors)].join('\n'));
  return [...byKey.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

/** Every package installed in a node_modules tree (pnpm `.pnpm` store layout or a hoisted/nested npm layout). */
export function collectFromNodeModules(nodeModules) {
  const dirs = new Set();
  const seen = new Set();
  const visit = (nm) => {
    if (!existsSync(nm)) return;
    const real = realpathSync(nm);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (entry.name === '.bin') continue;
      if (entry.name === '.pnpm') {
        for (const store of readdirSync(join(nm, '.pnpm'), { withFileTypes: true })) {
          if (store.isDirectory() && store.name !== 'node_modules') visit(join(nm, '.pnpm', store.name, 'node_modules'));
        }
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      const candidates = entry.name.startsWith('@')
        ? readdirSync(join(nm, entry.name)).map((n) => join(nm, entry.name, n))
        : [join(nm, entry.name)];
      for (const c of candidates) {
        if (!existsSync(join(c, 'package.json'))) continue;
        const realDir = realpathSync(c);
        // Workspace links (@asm/*) resolve outside node_modules; they are skipped by name below.
        dirs.add(realDir);
        visit(join(realDir, 'node_modules'));
      }
    }
  };
  visit(resolve(nodeModules));
  return collectFromDirs(dirs);
}

function renderEntry(p, components) {
  const lines = [SEPARATOR, `Package: ${p.name}@${p.version}`, `License: ${p.license}`];
  if (p.homepage) lines.push(`Homepage: ${p.homepage}`);
  if (components?.length) lines.push(`Used by: ${components.join(', ')}`);
  lines.push(SEPARATOR);
  for (const t of p.texts) lines.push('', `--- ${t.file} ---`, '', t.text);
  lines.push('');
  return lines.join('\n');
}

/** Renders a notices document. `packages` items may carry a `components` array (combined file). */
export function renderNotices(title, packages) {
  const header = [
    `THIRD-PARTY SOFTWARE NOTICES: ${title}`,
    '',
    'This distribution of Agent Secrets Manager (Apache-2.0, see LICENSE and NOTICE) includes the third-party',
    'software listed below. Each package is distributed under its own license, reproduced in full.',
    '',
    `Packages: ${packages.length}`,
    '',
  ].join('\n');
  return `${header}\n${packages.map((p) => renderEntry(p, p.components)).join('\n')}`;
}

/** Writes a notices file and returns the package count. */
export function writeNotices(outFile, title, packages) {
  writeFileSync(outFile, renderNotices(title, packages));
  return packages.length;
}

/** Parses a notices document produced by renderNotices back into package entries. */
export function parseNotices(text) {
  const chunks = text.split(ENTRY_RE).slice(1);
  return chunks.map((chunk) => {
    const end = chunk.indexOf(`\n${SEPARATOR}\n`);
    if (end < 0) throw new Error('third-party notices: malformed entry');
    const head = chunk.slice(0, end).split('\n');
    const key = head[0];
    const field = (k) => head.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
    const at = key.lastIndexOf('@');
    const texts = [];
    const body = chunk.slice(end + SEPARATOR.length + 2);
    const re = /^--- (.+) ---\n\n/gm;
    const marks = [...body.matchAll(re)];
    marks.forEach((m, i) => {
      const start = m.index + m[0].length;
      const stop = i + 1 < marks.length ? marks[i + 1].index : body.length;
      texts.push({ file: m[1], text: body.slice(start, stop).trim() });
    });
    return { name: key.slice(0, at), version: key.slice(at + 1), license: field('License'), homepage: field('Homepage'), texts };
  });
}

/** Merges labelled package lists into one list with `components`, deduplicated by name@version. */
export function mergeComponents(lists) {
  const byKey = new Map();
  for (const { label, packages } of lists) {
    for (const p of packages) {
      const key = `${p.name}@${p.version}`;
      const existing = byKey.get(key) ?? { ...p, components: [] };
      if (!existing.components.includes(label)) existing.components.push(label);
      byKey.set(key, existing);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd !== 'combine') {
    console.error('usage: third-party-notices.mjs combine --out FILE [--title T] [--node-modules DIR|--from FILE --label NAME]...');
    process.exit(2);
  }
  let out;
  let title = 'Agent Secrets Manager (Docker image: server, web UI, CLI)';
  const sources = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    if (a === '--out') out = v;
    else if (a === '--title') title = v;
    else if (a === '--node-modules' || a === '--from') sources.push({ kind: a, path: v, label: basename(v) });
    else if (a === '--label' && sources.length > 0) sources[sources.length - 1].label = v;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out || sources.length === 0) throw new Error('--out and at least one source are required');
  const lists = sources.map((s) => ({
    label: s.label,
    packages: s.kind === '--from' ? parseNotices(readFileSync(s.path, 'utf8')) : collectFromNodeModules(s.path),
  }));
  for (const l of lists) if (l.packages.length === 0) throw new Error(`third-party notices: no packages found for ${l.label}`);
  const merged = mergeComponents(lists);
  writeNotices(out, title, merged);
  console.log(`${out}: ${merged.length} packages (${lists.map((l) => `${l.label} ${l.packages.length}`).join(', ')})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
