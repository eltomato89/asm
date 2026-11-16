import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, isSemver } from '../src/commands/update.js';
import { runCli, SERVER, tmp } from './helpers.js';

const NEW = '#!/usr/bin/env node\nconsole.log("asm 1.2.0");\n';
const OLD = '#!/usr/bin/env node\nconsole.log("asm 1.0.0");\n';

function install() {
  const dir = tmp('asm-bin-');
  const real = join(dir, 'asm.mjs');
  writeFileSync(real, OLD, { mode: 0o755 });
  const link = join(dir, 'asm');
  symlinkSync(real, link);
  return { dir, real, link };
}

function server(o: { manifest?: Record<string, unknown>; body?: string } = {}) {
  const body = o.body ?? NEW;
  const manifest = o.manifest ?? { version: '1.2.0', sha256: createHash('sha256').update(NEW).digest('hex'), size: Buffer.byteLength(NEW) };
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (url === `${SERVER}/cli/asm.json`) return new Response(JSON.stringify(manifest), { status: 200 });
    if (url === `${SERVER}/cli/asm.mjs`) return new Response(body, { status: 200 });
    return new Response('{"error":"not_found"}', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}

describe('asm --version', () => {
  it('prints the version', async () => {
    const r = await runCli(['--version'], { deps: { version: '1.0.0' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('1.0.0\n');
  });
});

describe('asm update', () => {
  it('verifies and atomically replaces the real file behind the symlink (0755)', async () => {
    const { dir, real, link } = install();
    const s = server();
    const r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(0);
    expect(r.err).toContain('Updated asm 1.0.0 → 1.2.0');
    expect(readFileSync(real, 'utf8')).toBe(NEW);
    expect(statSync(real).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).sort()).toEqual(['asm', 'asm.mjs']);
    expect(s.urls).toEqual([`${SERVER}/cli/asm.json`, `${SERVER}/cli/asm.mjs`]);
  });

  it('--server overrides the default server', async () => {
    const { link } = install();
    const s = server();
    const r = await runCli(['--server', 'https://other.test', 'update'], { deps: { version: '1.0.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: update_not_available\n');
    expect(s.urls).toEqual(['https://other.test/cli/asm.json']);
  });

  it('hash mismatch → exit 1, file untouched, no temp file', async () => {
    const { dir, real, link } = install();
    const tampered = NEW.replace('1.2.0', '6.6.6');
    const r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch: server({ body: tampered }).fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: update_checksum_mismatch\n');
    expect(readFileSync(real, 'utf8')).toBe(OLD);
    expect(readdirSync(dir).sort()).toEqual(['asm', 'asm.mjs']);
  });

  it('size mismatch / invalid manifest → exit 1, file untouched', async () => {
    const { real, link } = install();
    let r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch: server({ body: `${NEW}x` }).fetch } });
    expect(r.err).toBe('asm: update_size_mismatch\n');
    r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch: server({ manifest: { version: '1.2.0', sha256: 'nope', size: 1 } }).fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: update_manifest_invalid\n');
    expect(readFileSync(real, 'utf8')).toBe(OLD);
  });

  it('same version → no-op (only the manifest is fetched); --force reinstalls', async () => {
    const { real, link } = install();
    let s = server();
    let r = await runCli(['update'], { deps: { version: '1.2.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(0);
    expect(r.err).toBe('asm 1.2.0 is up to date\n');
    expect(s.urls).toEqual([`${SERVER}/cli/asm.json`]);
    expect(readFileSync(real, 'utf8')).toBe(OLD);
    s = server();
    r = await runCli(['update', '--force'], { deps: { version: '1.2.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(0);
    expect(readFileSync(real, 'utf8')).toBe(NEW);
  });

  it('older version on the server → server_version_older, file untouched; --force downgrades', async () => {
    const { real, link } = install();
    let s = server();
    let r = await runCli(['update'], { deps: { version: '1.10.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^asm: server_version_older/);
    expect(s.urls).toEqual([`${SERVER}/cli/asm.json`]);
    expect(readFileSync(real, 'utf8')).toBe(OLD);
    s = server();
    r = await runCli(['update', '--force'], { deps: { version: '1.10.0', selfPath: link, fetch: s.fetch } });
    expect(r.code).toBe(0);
    expect(r.err).toContain('Updated asm 1.10.0 → 1.2.0');
    expect(readFileSync(real, 'utf8')).toBe(NEW);
  });

  it('compares versions semver-wise', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.0-dev')).toBe(1);
    expect(compareVersions('0.1.0-rc.2', '0.1.0-rc.10')).toBe(-1);
    expect(compareVersions('0.1.0-alpha', '0.1.0-1')).toBe(1);
    expect(compareVersions('garbage', '0.1.0')).toBeUndefined();
    expect(isSemver('0.1.0')).toBe(true);
    expect(isSemver('0.1')).toBe(false);
  });

  it('real file without .mjs extension → update_unsupported_layout, untouched', async () => {
    const dir = tmp('asm-bin-');
    const real = join(dir, 'asm');
    writeFileSync(real, OLD, { mode: 0o755 });
    const s = server();
    const r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: real, fetch: s.fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^asm: update_unsupported_layout \(re-run the installer/);
    expect(s.urls).toEqual([]);
    expect(readFileSync(real, 'utf8')).toBe(OLD);
  });

  it('content-length above the manifest size → size mismatch without reading the body', async () => {
    const { real, link } = install();
    const manifest = { version: '1.2.0', sha256: createHash('sha256').update(NEW).digest('hex'), size: Buffer.byteLength(NEW) };
    let pulled = 0;
    const fetch = (async (url: string) => {
      if (url.endsWith('/asm.json')) return new Response(JSON.stringify(manifest));
      const body = new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new TextEncoder().encode(NEW))) });
      return new Response(body, { headers: { 'content-length': String(1e9) } });
    }) as unknown as typeof globalThis.fetch;
    const r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch } });
    expect(r.err).toBe('asm: update_size_mismatch\n');
    expect(pulled).toBeLessThanOrEqual(1);
    expect(readFileSync(real, 'utf8')).toBe(OLD);
  });

  it('endless body without content-length → stops reading past the manifest size', async () => {
    const { real, link } = install();
    const manifest = { version: '1.2.0', sha256: createHash('sha256').update(NEW).digest('hex'), size: Buffer.byteLength(NEW) };
    let pulled = 0;
    const fetch = (async (url: string) => {
      if (url.endsWith('/asm.json')) return new Response(JSON.stringify(manifest));
      return new Response(new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(16))) }));
    }) as unknown as typeof globalThis.fetch;
    const r = await runCli(['update'], { deps: { version: '1.0.0', selfPath: link, fetch } });
    expect(r.err).toBe('asm: update_size_mismatch\n');
    expect(pulled).toBeLessThan(10);
    expect(readFileSync(real, 'utf8')).toBe(OLD);
  });

  it('not running from the bundle → update_unsupported', async () => {
    const r = await runCli(['update'], { deps: { fetch: server().fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^asm: update_unsupported/);
  });
});
