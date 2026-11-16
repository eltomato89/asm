import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeApi, requestDto, runCli, tmp } from './helpers.js';

const FOO_VALUE = 'foo_SET_TOPSECRET_value';

describe('asm set', () => {
  it('--new --from-env FOO sends the value of FOO and never prints it', async () => {
    const api = fakeApi({ createSecret: async () => ({ secretId: 'sec_NEW', version: 1 }) });
    const r = await runCli(
      ['set', '--new', '--title', 'Foo', '--description', 'the foo key', '--tags', 'a, b', '--env', 'FOO_KEY', '--project', 'p', '--reason', 'setup', '--from-env', 'FOO'],
      { api, env: { FOO: FOO_VALUE } },
    );
    expect(r.code).toBe(0);
    expect(api.createSecret).toHaveBeenCalledWith({
      title: 'Foo', description: 'the foo key', tags: ['a', 'b'], envName: 'FOO_KEY', vaultId: undefined, project: 'p', reason: 'setup', value: FOO_VALUE,
    });
    expect(r.out).toBe('sec_NEW v1\n');
    expect(r.out + r.err).not.toContain(FOO_VALUE);
  });

  it('without value source and without metadata flags → exit 2 with usage', async () => {
    const api = fakeApi();
    const r = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r'], { api });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Usage:');
    expect(api.updateSecret).not.toHaveBeenCalled();
  });

  it('without --project inside git repo foo-bar sends project "foo-bar"', async () => {
    const repo = join(tmp(), 'foo-bar');
    mkdirSync(join(repo, 'packages', 'x'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const api = fakeApi({ updateSecret: async () => requestDto({ kind: 'update' }) });
    const r = await runCli(['set', 'sec_1', '--reason', 'rotate', '--generate'], { api, cwd: join(repo, 'packages', 'x') });
    expect(r.code).toBe(0);
    expect(api.updateSecret).toHaveBeenCalledWith('sec_1', expect.objectContaining({ project: 'foo-bar', reason: 'rotate', generate: { length: 32 } }));
    expect(r.out).toBe('req_1\n');
  });

  it('outside git the folder name is the default project', async () => {
    const dir = join(tmp(), 'plain-folder');
    mkdirSync(dir);
    const api = fakeApi({ createRequest: async () => requestDto() });
    await runCli(['request', 'sec_1', '--reason', 'r'], { api, cwd: dir });
    expect(api.createRequest).toHaveBeenCalledWith({ secretId: 'sec_1', project: 'plain-folder', reason: 'r' });
  });

  it('update --wait prints the request id and the outcome; denied → exit 3', async () => {
    const api = fakeApi({
      updateSecret: async () => requestDto({ kind: 'update' }),
      waitRequest: async () => requestDto({ kind: 'update', status: 'approved', version: 2 }),
    });
    const r = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r', '--title', 'New title', '--wait'], { api });
    expect(r.code).toBe(0);
    expect(r.out).toBe('req_1\napproved v2\n');
    expect(api.updateSecret).toHaveBeenCalledWith('sec_1', { title: 'New title', description: undefined, tags: undefined, envName: undefined, project: 'p', reason: 'r' });

    const denied = fakeApi({ updateSecret: async () => requestDto({ kind: 'update' }), waitRequest: async () => requestDto({ kind: 'update', status: 'expired' }) });
    const d = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r', '--generate', '40', '--wait'], { api: denied });
    expect(d.code).toBe(3);
    expect(denied.updateSecret).toHaveBeenCalledWith('sec_1', expect.objectContaining({ generate: { length: 40 } }));
  });

  it('value sources: --from-stdin and --from-file strip one trailing newline; never printed', async () => {
    const api = fakeApi({ updateSecret: async () => requestDto({ kind: 'update' }) });
    const s = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r', '--from-stdin'], { api, stdin: `${FOO_VALUE}\n` });
    expect(s.code).toBe(0);
    expect(api.updateSecret).toHaveBeenLastCalledWith('sec_1', expect.objectContaining({ value: FOO_VALUE }));
    const dir = tmp();
    writeFileSync(join(dir, 'v.txt'), `${FOO_VALUE}\n`);
    const f = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r', '--from-file', 'v.txt'], { api, cwd: dir });
    expect(f.code).toBe(0);
    expect(api.updateSecret).toHaveBeenLastCalledWith('sec_1', expect.objectContaining({ value: FOO_VALUE }));
    expect(s.out + s.err + f.out + f.err).not.toContain(FOO_VALUE);
  });

  it('usage errors: two value sources, missing --reason, --new without title, unset env var, bad length', async () => {
    const api = fakeApi();
    const cases = [
      ['set', 'sec_1', '--reason', 'r', '--project', 'p', '--generate', '--from-env', 'FOO'],
      ['set', 'sec_1', '--project', 'p', '--generate'],
      ['set', '--new', '--reason', 'r', '--project', 'p', '--generate'],
      ['set', 'sec_1', '--reason', 'r', '--project', 'p', '--from-env', 'NOT_SET'],
      ['set', 'sec_1', '--reason', 'r', '--project', 'p', '--generate', '8'],
    ];
    for (const args of cases) expect((await runCli(args, { api, env: { FOO: 'x' } })).code, args.join(' ')).toBe(2);
    expect(api.updateSecret).not.toHaveBeenCalled();
    expect(api.createSecret).not.toHaveBeenCalled();
  });
});
