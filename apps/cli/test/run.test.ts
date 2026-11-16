import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@asm/shared/api-client';
import { fakeApi, requestDto, runCli, tmp } from './helpers.js';

const VALUE = 'ghp_RUN_TOPSECRET_123';
const GRANT = 'grt_01JTESTGRANT0000000000000A';

/** Runs `asm run` with the child's stdout captured into a file. */
async function runWithCapture(args: string[], api = fakeApi()) {
  const file = join(tmp(), 'child-out.txt');
  const fd = openSync(file, 'w');
  try {
    const r = await runCli(args, { api, env: process.env, deps: { childStdio: ['ignore', fd, 'inherit'] } });
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
});
