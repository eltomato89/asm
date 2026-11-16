import { EventEmitter } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@asm/shared/api-client';
import type { CliDeps } from '../src/runtime.js';
import { fakeApi, requestDto, runCli, tmp } from './helpers.js';

const VALUE = 'ghp_RUN_TOPSECRET_123';
const GRANT = 'grt_01JTESTGRANT0000000000000A';

/** Runs `asm run` with the child's stdout captured into a file. */
async function runWithCapture(args: string[], api = fakeApi(), deps: Partial<CliDeps> = {}) {
  const file = join(tmp(), 'child-out.txt');
  const fd = openSync(file, 'w');
  try {
    const r = await runCli(args, { api, env: process.env, deps: { childStdio: ['ignore', fd, 'inherit'], ...deps } });
    return { ...r, child: readFileSync(file, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

const redeemed = (envName: string | null = 'GITHUB_TOKEN') => async () => ({ secrets: [{ secretId: 'sec_1', envName, value: VALUE }] });

describe('asm run', () => {
  it('injects GITHUB_TOKEN into the child only; never prints the value', async () => {
    const api = fakeApi({ redeemGrant: redeemed() });
    const r = await runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', 'process.stdout.write(process.env.GITHUB_TOKEN)'], api);
    expect(r.code).toBe(0);
    expect(r.child).toBe(VALUE);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(r.out + r.err).not.toContain(VALUE);
    expect(api.redeemGrant).toHaveBeenCalledWith(GRANT, 'test-host');
  });

  it("passes the child's exit code through (3 → 3)", async () => {
    const r = await runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', 'process.exit(3)'], fakeApi({ redeemGrant: redeemed() }));
    expect(r.code).toBe(3);
  });

  it('a child killed by a signal → 128 + n', async () => {
    const r = await runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', "process.kill(process.pid, 'SIGTERM')"], fakeApi({ redeemGrant: redeemed() }));
    expect(r.code).toBe(143);
  });

  it('secret without env name and no =ENV mapping → exit 2 naming the secret; mapping fixes it', async () => {
    const r = await runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', ''], fakeApi({ redeemGrant: redeemed(null) }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('sec_1');
    expect(r.err).not.toContain(VALUE);
    const ok = await runWithCapture(['run', '--grant', `${GRANT}=MY_TOKEN`, '--', 'node', '-e', 'process.stdout.write(process.env.MY_TOKEN)'], fakeApi({ redeemGrant: redeemed(null) }));
    expect(ok.code).toBe(0);
    expect(ok.child).toBe(VALUE);
  });

  it('--secret creates a request, waits for approval, then redeems the grant', async () => {
    const api = fakeApi({
      createRequest: async () => requestDto(),
      waitRequest: async () => requestDto({ status: 'approved', grantId: GRANT }),
      redeemGrant: redeemed(),
    });
    const r = await runWithCapture(['run', '--secret', 'sec_1', '--reason', 'deploy', '--project', 'p', '--', 'node', '-e', 'process.stdout.write(process.env.GITHUB_TOKEN)'], api);
    expect(r.code).toBe(0);
    expect(r.err).toContain('Waiting for approval…');
    expect(r.child).toBe(VALUE);
    expect(api.createRequest).toHaveBeenCalledWith({ secretId: 'sec_1', project: 'p', reason: 'deploy' });
    expect(api.redeemGrant).toHaveBeenCalledWith(GRANT, 'test-host');
  });

  it('--secret denied → exit 3 without running the command', async () => {
    const api = fakeApi({ createRequest: async () => requestDto(), waitRequest: async () => requestDto({ status: 'denied' }) });
    const r = await runWithCapture(['run', '--secret', 'sec_1', '--reason', 'deploy', '--', 'node', '-e', 'process.stdout.write("ran")'], api);
    expect(r.code).toBe(3);
    expect(r.child).toBe('');
    expect(api.redeemGrant).not.toHaveBeenCalled();
  });

  it('usage errors → exit 2 (no command, no grant, --secret without --reason)', async () => {
    expect((await runCli(['run', '--grant', GRANT], { api: fakeApi() })).code).toBe(2);
    expect((await runCli(['run', '--', 'node'], { api: fakeApi() })).code).toBe(2);
    expect((await runCli(['run', '--secret', 'sec_1', '--', 'node'], { api: fakeApi() })).code).toBe(2);
    expect((await runCli(['run', '--grant', 'nope', '--', 'node'], { api: fakeApi() })).code).toBe(2);
  });

  it('API errors → exit 1 with the error code', async () => {
    const r = await runCli(['run', '--grant', GRANT, '--', 'node'], { api: fakeApi({ redeemGrant: async () => { throw new ApiError(410, 'grant_gone'); } }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: grant_gone\n');
  });

  it('forwards SIGTERM to the child; on a terminal SIGINT is swallowed (child decides) and its exit code propagates', async () => {
    const signals = new EventEmitter();
    const child =
      "process.on('SIGTERM', () => process.exit(7)); process.on('SIGINT', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)";
    const running = runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', child], fakeApi({ redeemGrant: redeemed() }), { signals, stdinIsTTY: true });
    for (let i = 0; i < 100 && signals.listenerCount('SIGTERM') === 0; i++) await new Promise((r) => setTimeout(r, 20));
    // asm keeps a SIGINT listener (so Node's default action does not kill it) but does not forward it.
    expect(signals.listenerCount('SIGINT')).toBe(1);
    await new Promise((r) => setTimeout(r, 300)); // child installs its handlers
    signals.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 100));
    signals.emit('SIGTERM');
    const r = await running;
    expect(r.code).toBe(7);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) expect(signals.listenerCount(sig)).toBe(0);
  });

  it('a real SIGINT to asm on a terminal does not kill it before the child exits (child exit code propagates)', async () => {
    const { spawn } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const dir = tmp();
    // Child ignores SIGINT, exits 5 after a short while.
    const script = join(dir, 'harness.mjs');
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    writeFileSync(
      script,
      `import { main } from ${JSON.stringify(cli)};
const api = { redeemGrant: async () => ({ secrets: [{ secretId: 'sec_1', envName: 'X', value: 'v' }] }) };
const code = await main(['run', '--grant', '${GRANT}', '--', 'node', '-e', "process.on('SIGINT', () => {}); process.stdout.write('ready'); setTimeout(() => process.exit(5), 700)"], {
  env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, readStdin: async () => '', configDir: ${JSON.stringify(dir)},
  hostname: 'h', stdinIsTTY: true, makeApi: () => api, storeFor: () => ({ get: async () => undefined, set: async () => {}, delete: async () => false }),
});
process.exitCode = code;
`,
    );
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultServer: 'https://asm.test' }));
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const p = spawn(process.execPath, ['--import', tsx, script], { stdio: ['ignore', 'pipe', 'inherit'], cwd: dir });
    const exited = new Promise<number | null>((resolve) => p.on('exit', (c) => resolve(c)));
    let out = '';
    await Promise.race([new Promise<void>((resolve) => p.stdout.on('data', (d: Buffer) => ((out += d), out.includes('ready') && resolve()))), exited]);
    p.kill('SIGINT'); // the asm parent receives SIGINT (as from Ctrl-C)
    expect(await exited).toBe(5);
  }, 15_000);

  it('duplicate env names → exit 2 before anything is redeemed', async () => {
    const api = fakeApi({ redeemGrant: redeemed() });
    const r = await runCli(['run', '--grant', `${GRANT}=A`, '--grant', 'grt_01JTESTGRANT0000000000000B=A', '--', 'node'], { api });
    expect(r.code).toBe(2);
    expect(r.err).toContain('duplicate env name A');
    expect(api.redeemGrant).not.toHaveBeenCalled();
    // names only known after redemption are checked before running anything
    const r2 = await runWithCapture(['run', '--grant', GRANT, '--grant', 'grt_01JTESTGRANT0000000000000B', '--', 'node', '-e', 'process.stdout.write("ran")'], fakeApi({ redeemGrant: redeemed() }));
    expect(r2.code).toBe(2);
    expect(r2.child).toBe('');
  });

  it('server-supplied env names are re-validated (exit 1 invalid_env_name)', async () => {
    const r = await runWithCapture(['run', '--grant', GRANT, '--', 'node', '-e', 'process.stdout.write("ran")'], fakeApi({ redeemGrant: redeemed('PATH;rm -rf') }));
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: invalid_env_name\n');
    expect(r.child).toBe('');
  });
});

