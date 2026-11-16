import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { Command } from 'commander';
import { collectEnv } from '../inject.js';
import { CliError, EXIT, usage, type Runtime } from '../runtime.js';

export type RunOptions = { grant: string[]; secret: string[]; project?: string; reason?: string };

/** SIGINT from a terminal already reaches the child via the process group; forward it only when not interactive. */
const forwardedSignals = (stdinIsTTY: boolean): NodeJS.Signals[] => (stdinIsTTY ? ['SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP']);

/** Spawns the command with the injected env vars (only in the child) and returns its exit code. */
export async function runCommand(rt: Runtime, cmd: Command, argv: string[], opts: RunOptions): Promise<number> {
  if (argv.length === 0) usage(cmd, 'missing command (asm run --grant <id> -- <command…>)');
  const vars = await collectEnv(rt, { grants: opts.grant, secrets: opts.secret, project: opts.project, reason: opts.reason });
  const env: NodeJS.ProcessEnv = { ...rt.deps.env };
  for (const v of vars) env[v.name] = v.value;

  return new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: rt.deps.childStdio ?? 'inherit', env });
    const source = rt.deps.signals ?? process;
    const forward = new Map(forwardedSignals(rt.deps.stdinIsTTY === true).map((sig) => [sig, () => void child.kill(sig)] as const));
    for (const [sig, fn] of forward) source.on(sig, fn);
    const cleanup = () => {
      for (const [sig, fn] of forward) source.off(sig, fn);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(new CliError(err.code === 'ENOENT' ? 127 : 126, `cannot run ${argv[0]}: ${err.code ?? 'error'}`));
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}

export function registerRun(program: Command, rt: () => Runtime, setExit: (code: number) => void): void {
  const collect = (v: string, acc: string[]) => [...acc, v];
  const cmd = program
    .command('run')
    .description('Run a command with secrets injected as environment variables (only into that process)')
    .option('--grant <id[=ENV]>', 'grant id from an approved request (repeatable)', collect, [])
    .option('--secret <id[=ENV]>', 'request access to a secret and wait for approval (repeatable)', collect, [])
    .option('--project <name>', 'project name (default: git repo / folder name)')
    .option('--reason <text>', 'reason for --secret requests')
    .argument('[command...]', 'command to run (after --)')
    .passThroughOptions()
    .action(async (argv: string[], opts: RunOptions) => setExit(await runCommand(rt(), cmd, argv, opts)));
}
