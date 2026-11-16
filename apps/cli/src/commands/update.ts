import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
    typeof m.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version) ||
    typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256) ||
    typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_BUNDLE_BYTES
  ) fail('update_manifest_invalid');
  return { version: m.version, sha256: m.sha256, size: m.size };
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
  if (manifest.version === current && !opts.force) {
    rt.stderr.write(`asm ${current} is up to date\n`);
    return;
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await (await download(f, `${server}/cli/asm.mjs`)).arrayBuffer());
  } catch (err) {
    if (err instanceof CliError) throw err;
    fail('update_download_failed');
  }
  if (data.length !== manifest.size) fail('update_size_mismatch');
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
    .option('--force', 'reinstall even if the server has the same version')
    .action(async (o: { force?: boolean }) => update(rt(), { force: o.force }));
}
