import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeDotenv, quoteDotenv } from '../src/commands/write.js';
import { fakeApi, runCli, tmp } from './helpers.js';

const GRANT = 'grt_01JTESTGRANT0000000000000A';
const VALUE = 'ghp_WRITE_TOPSECRET';
const api = (value = VALUE, envName: string | null = 'GITHUB_TOKEN') => fakeApi({ redeemGrant: async () => ({ secrets: [{ secretId: 'sec_1', envName, value }] }) });
const mode = (f: string) => statSync(f).mode & 0o777;

describe('asm write', () => {
  it('creates the file with mode 0600 and never prints the value', async () => {
    const dir = tmp();
    const r = await runCli(['write', '--grant', GRANT, '.env'], { api: api(), cwd: dir });
    expect(r.code).toBe(0);
    const file = join(dir, '.env');
    expect(readFileSync(file, 'utf8')).toBe(`GITHUB_TOKEN="${VALUE}"\n`);
    expect(mode(file)).toBe(0o600);
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it('replaces an existing line of the same name, keeps the rest, tightens the mode', async () => {
    const dir = tmp();
    const file = join(dir, '.env');
    writeFileSync(file, '# config\nFOO=bar\nexport GITHUB_TOKEN=old\nBAZ="x"\n');
    chmodSync(file, 0o644);
    const r = await runCli(['write', '--grant', GRANT, '.env'], { api: api(), cwd: dir });
    expect(r.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(`# config\nFOO=bar\nGITHUB_TOKEN="${VALUE}"\nBAZ="x"\n`);
    expect(mode(file)).toBe(0o600);
  });

  it('appends when the name is new', () => {
    expect(mergeDotenv('A=1', [{ name: 'B', value: 'two' }])).toBe('A=1\nB="two"\n');
    expect(mergeDotenv('', [{ name: 'B', value: 'two' }])).toBe('B="two"\n');
    expect(mergeDotenv('GITHUB_TOKEN_OLD=1\n', [{ name: 'GITHUB_TOKEN', value: 'x' }])).toBe('GITHUB_TOKEN_OLD=1\nGITHUB_TOKEN="x"\n');
  });

  it('quotes values: escapes backslash, double quote, $ and newlines', () => {
    expect(quoteDotenv('a\\b"c$d\ne`x`')).toBe('"a\\\\b\\"c\\$d\\ne\\`x\\`"');
  });

  it('warns on stderr when the file is not ignored inside a git repo', async () => {
    const dir = tmp();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const r = await runCli(['write', '--grant', GRANT, '.env'], { api: api(), cwd: dir });
    expect(r.code).toBe(0);
    expect(r.err).toContain('.env is not ignored by git');

    writeFileSync(join(dir, '.gitignore'), '.env\n');
    const ok = await runCli(['write', '--grant', GRANT, '.env'], { api: api(), cwd: dir });
    expect(ok.err).not.toContain('not ignored');
  });

  it('no warning outside a git repo; works for files in subdirectories', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'sub'));
    const r = await runCli(['write', '--grant', GRANT, 'sub/.env.local'], { api: api(), cwd: dir });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('not ignored');
    expect(mode(join(dir, 'sub/.env.local'))).toBe(0o600);
  });

  it('secret without env name → exit 2; --grant id=ENV maps it', async () => {
    const dir = tmp();
    const r = await runCli(['write', '--grant', GRANT, '.env'], { api: api(VALUE, null), cwd: dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain('sec_1');
    const ok = await runCli(['write', '--grant', `${GRANT}=MY_KEY`, '.env'], { api: api(VALUE, null), cwd: dir });
    expect(ok.code).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`MY_KEY="${VALUE}"\n`);
  });

  it('values survive `set -a; . ./.env` in sh exactly, without executing anything', async () => {
    const dir = tmp();
    const marker = join(dir, 'PWNED');
    const values = [
      `a\`touch ${marker}\`b`,
      `$(touch ${marker})`,
      'q"uo\\te\\" $HOME ${HOME} \\$x',
      '`id`|sh; echo "$(whoami)"',
    ];
    for (const value of values) {
      const r = await runCli(['write', '--grant', GRANT, '.env'], { api: api(value), cwd: dir });
      expect(r.code).toBe(0);
      const out = execFileSync('sh', ['-c', 'set -a; . ./.env; printf %s "$GITHUB_TOKEN"'], { cwd: dir, encoding: 'utf8' });
      expect(out).toBe(value);
      expect(existsSync(marker)).toBe(false);
    }
    // Newlines are written as \n (dotenv convention): sh keeps them literal, still without executing anything.
    await runCli(['write', '--grant', GRANT, '.env'], { api: api(`l1\n$(touch ${marker})`), cwd: dir });
    const out = execFileSync('sh', ['-c', 'set -a; . ./.env; printf %s "$GITHUB_TOKEN"'], { cwd: dir, encoding: 'utf8' });
    expect(out).toBe(`l1\\n$(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(dir)).toEqual(['.env']);
  });
});

