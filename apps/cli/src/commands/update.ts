import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Command } from 'commander';
import { CliError, EXIT, type Runtime } from '../runtime.js';
import { stripControl } from '../sanitize.js';
import { BUNDLED, VERSION } from '../version.js';

export type CliManifest = { version: string; sha256: string; size: number };

/** Upper bound for the bundle download (the real bundle is well below 5 MB). */
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function fail(code: string): never {
  throw new CliError(EXIT.api, code);
}

function parseManifest(raw: unknown): CliManifest {
  const m = raw as Record<string, unknown> | null;
  if (
    !m || typeof m !== 'object' ||
    typeof m.version !== 'string' || m.version.length > 64 || !isSemver(m.version) ||
    typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256) ||
    typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_BUNDLE_BYTES
  ) fail('update_manifest_invalid');
  return { version: m.version, sha256: m.sha256, size: m.size };
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isSemver = (v: string): boolean => SEMVER.test(v);

/** Semver precedence: <0 if a<b, 0 if equal, >0 if a>b; undefined if either is not a semver version. */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return undefined;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const x = xa[i];
    const y = xb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function download(f: typeof fetch, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } });
  } catch {
    fail('update_download_failed');
  }
  if (res.status === 404) fail('update_not_available');
  if (!res.ok) fail('update_download_failed');
  return res;
}

/** Reads a response body of exactly `size` bytes; stops reading (and fails) as soon as it would exceed `size`. */
async function readExactly(res: Response, size: number): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) !== size) fail('update_size_mismatch');
  if (!res.body) fail('update_download_failed');
  const out = new Uint8Array(size);
  let len = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (len + value.length > size) fail('update_size_mismatch');
      out.set(value, len);
      len += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (len !== size) fail('update_size_mismatch');
  return out;
}

/** Writes `data` next to `target` (exclusive temp file, mode 0755) and renames it over `target`; never leaves a partial file. */
export function replaceFileAtomically(target: string, data: Uint8Array): void {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  let renamed = false;
  try {
    const fd = openSync(tmp, 'wx', 0o755);
    created = true;
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (created && !renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
}

/** Downloads the CLI bundle from the server, verifies size + SHA-256 and atomically replaces the running asm file. */
export async function update(rt: Runtime, opts: { force?: boolean } = {}): Promise<void> {
  const current = rt.deps.version ?? VERSION;
  const self = rt.deps.selfPath ?? (BUNDLED ? process.argv[1] : undefined);
  if (!self) fail('update_unsupported (not a bundled install; rebuild from the repository instead)');
  let target: string;
  try {
    target = realpathSync(self);
  } catch {
    fail('update_target_missing');
  }
  // The installer puts the real file at ~/.local/share/asm/asm.mjs (symlinked from ~/.local/bin/asm); the .mjs
  // extension is what makes Node load it as ESM, so it must be kept.
  if (extname(target) !== '.mjs') fail('update_unsupported_layout (re-run the installer: curl -fsSL <server>/cli/install.sh | sh)');
  const server = rt.server();
  const f = rt.deps.fetch ?? globalThis.fetch;

  let manifestRaw: unknown;
  try {
    manifestRaw = await (await download(f, `${server}/cli/asm.json`)).json();
  } catch (err) {
    if (err instanceof CliError) throw err;
    fail('update_manifest_invalid');
  }
  const manifest = parseManifest(manifestRaw);
  // An unparseable local version (e.g. a custom build) counts as older than the server's.
  const cmp = compareVersions(manifest.version, current) ?? 1;
  if (!opts.force) {
    if (cmp === 0) {
      rt.stderr.write(`asm ${current} is up to date\n`);
      return;
    }
    if (cmp < 0) fail(`server_version_older (server has ${manifest.version}, this is ${stripControl(current)}; use --force to install it)`);
  }

  let data: Uint8Array;
  try {
    data = await readExactly(await download(f, `${server}/cli/asm.mjs`), manifest.size);
  } catch (err) {
    if (err instanceof CliError) throw err;
    fail('update_download_failed');
  }
  if (createHash('sha256').update(data).digest('hex') !== manifest.sha256) fail('update_checksum_mismatch');

  try {
    replaceFileAtomically(target, data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    fail(code === 'EACCES' || code === 'EPERM' ? `update_write_failed (no permission to write ${target})` : 'update_write_failed');
  }
  rt.stderr.write(`Updated asm ${stripControl(current)} → ${stripControl(manifest.version)} (${target})\n`);
}

export function registerUpdate(program: Command, rt: () => Runtime): void {
  program
    .command('update')
    .description('Update this asm installation from the server (verified by SHA-256)')
    .option('--force', 'install even if the server has the same or an older version')
    .action(async (o: { force?: boolean }) => update(rt(), { force: o.force }));
}
