import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { writePrivateFile } from '../auth-store.js';
import { collectEnv, type EnvVar } from '../inject.js';
import { usage, type Runtime } from '../runtime.js';

/** Double-quoted dotenv value: escapes `\`, `"`, `$`, backtick and newlines (safe for `set -a; . ./file`). */
export function quoteDotenv(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces an existing `KEY=` line (optionally `export KEY=`) or appends; keeps all other lines. */
export function mergeDotenv(content: string, vars: EnvVar[]): string {
  const lines = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const v of vars) {
    const line = `${v.name}=${quoteDotenv(v.value)}`;
    const re = new RegExp(`^\\s*(export\\s+)?${escapeRe(v.name)}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

/** True if the file lies in a git work tree but is not ignored. */
function notGitIgnored(file: string): boolean {
  const cwd = dirname(file);
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return false;
  const ignored = spawnSync('git', ['check-ignore', '-q', basename(file)], { cwd, stdio: 'ignore' });
  return ignored.status !== 0;
}

export async function writeCommand(rt: Runtime, cmd: Command, file: string | undefined, opts: { grant: string[] }): Promise<void> {
  if (!file) usage(cmd, 'missing file');
  if (opts.grant.length === 0) usage(cmd, 'give at least one --grant');
  const vars = await collectEnv(rt, { grants: opts.grant, secrets: [] });
  const path = resolve(rt.deps.cwd, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writePrivateFile(path, mergeDotenv(current, vars));
  rt.stderr.write(`Wrote ${vars.map((v) => v.name).join(', ')} to ${file}\n`);
  if (notGitIgnored(path)) rt.stderr.write(`asm: warning: ${file} is not ignored by git (add it to .gitignore)\n`);
}

export function registerWrite(program: Command, rt: () => Runtime): void {
  const collect = (v: string, acc: string[]) => [...acc, v];
  const cmd = program
    .command('write')
    .description('Write secrets from grants into a dotenv file (mode 0600, merged)')
    .option('--grant <id[=ENV]>', 'grant id from an approved request (repeatable)', collect, [])
    .argument('[file]', 'dotenv file')
    .action(async (file: string | undefined, opts: { grant: string[] }) => writeCommand(rt(), cmd, file, opts));
}
