import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { GenerateInput } from '@asm/shared/api-client';
import { CliError, EXIT, usage, type Runtime } from '../runtime.js';
import { stripControl } from '../sanitize.js';

export type SetOptions = {
  new?: boolean;
  title?: string;
  description?: string;
  tags?: string;
  env?: string;
  vault?: string;
  project?: string;
  reason?: string;
  fromStdin?: boolean;
  fromEnv?: string;
  fromFile?: string;
  generate?: boolean | string;
  wait?: boolean;
};

const DEFAULT_GENERATE_LENGTH = 32;
const stripNewline = (s: string) => s.replace(/\r?\n$/, '');

/** Resolves the single value source; never prints the value. */
async function valueSource(rt: Runtime, cmd: Command, o: SetOptions): Promise<{ value?: string; generate?: GenerateInput } | undefined> {
  const given = [o.fromStdin, o.fromEnv, o.fromFile, o.generate].filter((x) => x !== undefined && x !== false);
  if (given.length > 1) usage(cmd, 'give only one of --from-stdin, --from-env, --from-file, --generate');
  let value: string | undefined;
  if (o.fromStdin) {
    if (rt.deps.stdinIsTTY) usage(cmd, '--from-stdin needs piped input (e.g. `pbpaste | asm set …`), or use --from-env');
    value = stripNewline(await rt.deps.readStdin());
  }
  else if (o.fromEnv !== undefined) {
    value = rt.deps.env[o.fromEnv];
    if (value === undefined) throw new CliError(EXIT.usage, `environment variable ${o.fromEnv} is not set`);
  } else if (o.fromFile !== undefined) {
    try {
      value = stripNewline(readFileSync(resolve(rt.deps.cwd, o.fromFile), 'utf8'));
    } catch {
      throw new CliError(EXIT.usage, `cannot read ${o.fromFile}`);
    }
  } else if (o.generate !== undefined && o.generate !== false) {
    const length = o.generate === true ? DEFAULT_GENERATE_LENGTH : Number(o.generate);
    if (!Number.isInteger(length) || length < 16 || length > 256) usage(cmd, '--generate length must be an integer between 16 and 256');
    return { generate: { length } };
  } else return undefined;
  if (value === '') throw new CliError(EXIT.usage, 'empty value');
  return { value };
}

const parseTags = (tags: string | undefined) =>
  tags === undefined ? undefined : tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);

export async function setCommand(rt: Runtime, cmd: Command, secretId: string | undefined, o: SetOptions): Promise<void> {
  if (!o.reason || o.reason.trim() === '') usage(cmd, '--reason is required');
  const source = await valueSource(rt, cmd, o);
  const meta = { title: o.title, description: o.description, tags: parseTags(o.tags), envName: o.env };
  const hasMeta = Object.values(meta).some((v) => v !== undefined);

  if (o.new) {
    if (secretId) usage(cmd, '--new takes no secret id');
    if (!o.title || o.description === undefined) usage(cmd, '--new requires --title and --description');
    if (!source) usage(cmd, '--new requires a value source (--from-stdin, --from-env, --from-file or --generate)');
    const project = rt.project(o.project);
    const out = await rt.api().createSecret({ ...meta, title: o.title, vaultId: o.vault, project, reason: o.reason, ...source });
    rt.stdout.write(`${stripControl(out.secretId)} v${Number(out.version)}\n`);
    return;
  }

  if (!secretId) usage(cmd, 'missing secret id (or --new)');
  if (o.vault !== undefined) usage(cmd, '--vault only applies to --new');
  if (!source && !hasMeta) usage(cmd, 'nothing to change: give a value source or metadata flags');
  const project = rt.project(o.project);
  const dto = await rt.api().updateSecret(secretId, { ...meta, project, reason: o.reason, ...source });
  rt.stdout.write(`${stripControl(dto.id)}\n`);
  if (dto.status === 'pending' && !o.wait) {
    rt.stderr.write('Update requested; approve it in ASM.\n');
    return;
  }
  const done = await rt.awaitDecision(dto);
  rt.stdout.write(`approved v${done.version ?? '?'}\n`.replace(/[^\x20-\x7e\n]/g, ''));
}

export function registerSet(program: Command, rt: () => Runtime): void {
  const cmd = program
    .command('set')
    .description('Create a secret (--new) or propose a change to one (needs approval)')
    .argument('[secretId]', 'secret to change')
    .option('--new', 'create a new secret')
    .option('--title <title>', 'title')
    .option('--description <text>', 'description')
    .option('--tags <a,b>', 'comma-separated tags')
    .option('--env <NAME>', 'environment variable name')
    .option('--vault <id>', 'target vault for --new (default: personal vault)')
    .option('--project <name>', 'project name (default: git repo / folder name)')
    .option('--reason <text>', 'reason (required)')
    .option('--from-stdin', 'read the value from stdin')
    .option('--from-env <VAR>', 'read the value from an environment variable')
    .option('--from-file <file>', 'read the value from a file')
    .option('--generate [length]', 'let the server generate a random value (default length 32)')
    .option('--wait', 'wait for the approval of a change')
    .action(async (secretId: string | undefined, o: SetOptions) => setCommand(rt(), cmd, secretId, o));
}
