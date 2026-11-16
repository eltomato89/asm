import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../src/config.js';
import { renderInstallScript } from '../src/cli-dist/install-script.js';
import { createTestApp } from './helpers/testApp.js';

/** Tiny ESM bundle: the import statement proves the installed command is loaded as a module. */
const BUNDLE = "#!/usr/bin/env node\nimport { argv } from 'node:process';\nif (argv.includes('--version')) console.log('1.2.3');\n";
const SHA = createHash('sha256').update(BUNDLE).digest('hex');

function makeCliDir(manifest: Record<string, unknown> = { version: '1.2.3', sha256: SHA, size: Buffer.byteLength(BUNDLE) }): string {
  const dir = mkdtempSync(join(tmpdir(), 'asm-cli-'));
  writeFileSync(join(dir, 'asm.mjs'), BUNDLE);
  writeFileSync(join(dir, 'asm.json'), JSON.stringify(manifest));
  return dir;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('CLI distribution routes', () => {
  it('serves the bundle with content type, no-cache and a strong sha256 ETag', async () => {
    ({ app } = await createTestApp({ config: { cliDir: makeCliDir() } }));
    const res = await app.inject({ method: 'GET', url: '/cli/asm.mjs' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BUNDLE);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toBe(`"${SHA}"`);
  });

  it('answers 304 for a matching If-None-Match and 200 otherwise', async () => {
    ({ app } = await createTestApp({ config: { cliDir: makeCliDir() } }));
    const hit = await app.inject({ method: 'GET', url: '/cli/asm.mjs', headers: { 'if-none-match': `"other", "${SHA}"` } });
    expect(hit.statusCode).toBe(304);
    expect(hit.body).toBe('');
    expect(hit.headers.etag).toBe(`"${SHA}"`);
    const miss = await app.inject({ method: 'GET', url: '/cli/asm.mjs', headers: { 'if-none-match': '"nope"' } });
    expect(miss.statusCode).toBe(200);
  });

  it('does not answer 304 when asm.mjs is missing', async () => {
    const dir = makeCliDir();
    rmSync(join(dir, 'asm.mjs'));
    ({ app } = await createTestApp({ config: { cliDir: dir } }));
    const res = await app.inject({ method: 'GET', url: '/cli/asm.mjs', headers: { 'if-none-match': `"${SHA}"` } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'cli_not_available' });
  });

  it('serves the manifest', async () => {
    ({ app } = await createTestApp({ config: { cliDir: makeCliDir() } }));
    const res = await app.inject({ method: 'GET', url: '/cli/asm.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: '1.2.3', sha256: SHA, size: Buffer.byteLength(BUNDLE) });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves install.sh with the origin embedded', async () => {
    ({ app } = await createTestApp({ config: { cliDir: makeCliDir(), publicUrl: new URL('https://asm.example:8443/ignored/path') } }));
    const res = await app.inject({ method: 'GET', url: '/cli/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(res.body).toContain("ASM_URL='https://asm.example:8443'\n");
    expect(res.body).not.toContain('/ignored/path');
    expect(res.body).not.toContain('sudo ');
  });

  it('returns cli_not_available without a bundle', async () => {
    for (const cliDir of [null, join(tmpdir(), 'asm-cli-missing-xyz'), makeCliDir({ version: '1', sha256: 'zz', size: 1 })]) {
      ({ app } = await createTestApp({ config: { cliDir } }));
      for (const url of ['/cli/install.sh', '/cli/asm.mjs', '/cli/asm.json']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `${cliDir} ${url}`).toBe(404);
        expect(res.json()).toEqual({ error: 'cli_not_available' });
      }
      await app.close();
      app = undefined;
    }
  });

  it('does not route unknown /cli paths to the SPA fallback', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'asm-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    ({ app } = await createTestApp({ config: { cliDir: makeCliDir() }, webDistDir: dist }));
    for (const url of ['/cli', '/cli/unknown', '/cli/asm.mjs/x']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'not_found' });
    }
    expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
  });
});

describe('install script rendering', () => {
  it('refuses origins with shell-relevant characters', () => {
    for (const bad of ["https://a'b.example", 'https://a.example;rm', 'https://a.example$(x)', 'ftp://a.example']) {
      expect(() => renderInstallScript(bad), bad).toThrow();
    }
    expect(() => renderInstallScript('http://[::1]:8080')).not.toThrow();
  });

  it('is validated by loadConfig (underscores allowed)', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    expect(() => loadConfig({ ASM_PUBLIC_URL: "https://a'b.example", ASM_MASTER_KEY: key })).toThrow(ConfigError);
    expect(() => loadConfig({ ASM_PUBLIC_URL: "https://a'b.example", ASM_MASTER_KEY: key })).toThrow(/ASM_PUBLIC_URL/);
    expect(loadConfig({ ASM_PUBLIC_URL: 'https://asm_host.example', ASM_MASTER_KEY: key }).publicUrl.origin).toBe('https://asm_host.example');
    expect(() => renderInstallScript('https://asm_host.example')).not.toThrow();
  });
});

describe('ASM_CLI_DIR config', () => {
  const env = { ASM_PUBLIC_URL: 'https://asm.test', ASM_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') };
  it('uses ASM_CLI_DIR when set', () => {
    expect(loadConfig({ ...env, ASM_CLI_DIR: '/opt/asm-cli' }).cliDir).toBe('/opt/asm-cli');
  });
  it('prefers /app/cli, then the repo bundle, else null', () => {
    const none = () => false;
    expect(loadConfig(env, undefined, (p) => p === '/app/cli').cliDir).toBe('/app/cli');
    expect(loadConfig(env, undefined, (p) => p.endsWith('/apps/cli/dist-bundle'))?.cliDir).toMatch(/apps\/cli\/dist-bundle$/);
    expect(loadConfig(env, undefined, none).cliDir).toBeNull();
  });
});

// --- real install.sh run against a listening test server ---

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function runSh(script: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('sh', ['-s'], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin?.end(script);
  });
}

function runFile(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 10_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout });
    });
  });
}

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('install.sh end to end', () => {
  async function serve(cliDir: string): Promise<{ origin: string; script: string }> {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    ({ app } = await createTestApp({ config: { cliDir, publicUrl: new URL(origin) } }));
    await app.listen({ port, host: '127.0.0.1' });
    const script = await (await fetch(`${origin}/cli/install.sh`)).text();
    return { origin, script };
  }

  const NODE_PATH = `${dirname(process.execPath)}:${SYSTEM_PATH}`;
  const newHome = () => mkdtempSync(join(tmpdir(), 'asm-home-'));

  it('installs asm.mjs under ASM_HOME and links ASM_INSTALL_DIR/asm to it', async () => {
    const { origin, script } = await serve(makeCliDir());
    const home = newHome();
    const bin = join(home, 'bin');
    const asmHome = join(home, 'share');
    const r = await runSh(script, { PATH: NODE_PATH, HOME: home, ASM_INSTALL_DIR: bin, ASM_HOME: asmHome });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const real = join(asmHome, 'asm.mjs');
    expect(readFileSync(real, 'utf8')).toBe(BUNDLE);
    expect(statSync(real).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(bin, 'asm')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(bin, 'asm'))).toBe(real);
    expect(readdirSync(bin)).toEqual(['asm']);
    expect(readdirSync(asmHome)).toEqual(['asm.mjs']);
    expect(r.stdout).toContain('Installed asm 1.2.3');
    expect(r.stdout).toContain('is not on your PATH');
    expect(r.stdout).toContain(`asm login ${origin}`);
    // The symlinked command runs as ESM (the fake bundle uses an import statement).
    const run = await runFile(join(bin, 'asm'), ['--version'], { PATH: NODE_PATH, HOME: home });
    expect(run).toEqual({ code: 0, stdout: '1.2.3\n' });
  });

  it('defaults to $HOME/.local/bin and $HOME/.local/share/asm and replaces an existing asm', async () => {
    const { script } = await serve(makeCliDir());
    const home = newHome();
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'asm'), 'old');
    const r = await runSh(script, { PATH: `${bin}:${NODE_PATH}`, HOME: home });
    expect(r.code).toBe(0);
    expect(readlinkSync(join(bin, 'asm'))).toBe(join(home, '.local', 'share', 'asm', 'asm.mjs'));
    expect(readFileSync(join(bin, 'asm'), 'utf8')).toBe(BUNDLE);
    expect(r.stdout).not.toContain('is not on your PATH');
    // Re-running replaces the link in place.
    expect((await runSh(script, { PATH: `${bin}:${NODE_PATH}`, HOME: home })).code).toBe(0);
    expect(readdirSync(bin)).toEqual(['asm']);
  });

  it('aborts on a hash mismatch and installs nothing', async () => {
    const { script } = await serve(makeCliDir({ version: '1.2.3', sha256: 'a'.repeat(64), size: Buffer.byteLength(BUNDLE) }));
    const home = newHome();
    const r = await runSh(script, { PATH: NODE_PATH, HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(readdirSync(home)).toEqual([]);
  });

  it('aborts on a size mismatch and installs nothing', async () => {
    const { script } = await serve(makeCliDir({ version: '1.2.3', sha256: SHA, size: Buffer.byteLength(BUNDLE) + 1 }));
    const home = newHome();
    const r = await runSh(script, { PATH: NODE_PATH, HOME: home });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('size mismatch');
    expect(readdirSync(home)).toEqual([]);
  });

  it('executes nothing from a truncated download', async () => {
    const { script } = await serve(makeCliDir());
    // Cut mid-byte-stream and right before the final `main` call: nothing may run.
    const lines = script.split('\n');
    const cuts = [script.slice(0, Math.floor(script.length / 2)), `${lines.slice(0, lines.length - 2).join('\n')}\n`];
    for (const [cut, truncated] of cuts.entries()) {
      const home = newHome();
      const r = await runSh(truncated, { PATH: NODE_PATH, HOME: home });
      expect(readdirSync(home), `cut ${cut}`).toEqual([]);
      expect(r.stdout, `cut ${cut}`).toBe('');
    }
  });

  it('refuses Node.js older than 22', async () => {
    const { script } = await serve(makeCliDir());
    const home = mkdtempSync(join(tmpdir(), 'asm-home-'));
    const fakeBin = join(home, 'fakebin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'node'), '#!/bin/sh\ncase "$1" in -p) echo 20 ;; --version) echo v20.0.0 ;; esac\n');
    chmodSync(join(fakeBin, 'node'), 0o755);
    const r = await runSh(script, { PATH: `${fakeBin}:${SYSTEM_PATH}`, HOME: home, ASM_INSTALL_DIR: join(home, 'bin') });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Node.js >= 22 is required (found v20.0.0)');
    expect(readdirSync(home)).toEqual(['fakebin']);
  });
});
