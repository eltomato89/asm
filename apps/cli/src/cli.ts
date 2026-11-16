import { Command, CommanderError } from 'commander';
import { ApiError } from '@asm/shared/api-client';
import { StoreError } from './auth-store.js';
import { stripControl } from './sanitize.js';
import { registerArchive } from './commands/archive.js';
import { registerLogin } from './commands/login.js';
import { registerLogout } from './commands/logout.js';
import { registerMcpConfig } from './commands/mcp-config.js';
import { registerRequest } from './commands/request.js';
import { registerRun } from './commands/run.js';
import { registerSearch } from './commands/search.js';
import { registerSet } from './commands/set.js';
import { registerUpdate } from './commands/update.js';
import { registerWrite } from './commands/write.js';
import { CliError, EXIT, Runtime, type CliDeps, type GlobalOptions } from './runtime.js';
import { VERSION } from './version.js';

export function buildProgram(deps: CliDeps, setExit: (code: number) => void): Command {
  const program = new Command('asm')
    .description('ASM – Agent Secrets Manager CLI')
    .version(deps.version ?? VERSION, '-V, --version', 'print the asm version')
    .option('--server <url>', 'ASM server URL (default: the one from asm login)')
    .option('--insecure-store', 'use ~/.config/asm/credentials.json instead of the OS keychain')
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (s) => void deps.stdout.write(s), writeErr: (s) => void deps.stderr.write(s) });
  const rt = (overrides: GlobalOptions = {}) => new Runtime(deps, { ...program.opts<GlobalOptions>(), ...overrides });
  registerLogin(program, rt);
  registerLogout(program, rt);
  registerSearch(program, rt);
  registerRequest(program, rt);
  registerRun(program, rt, setExit);
  registerWrite(program, rt);
  registerSet(program, rt);
  registerArchive(program, rt);
  registerMcpConfig(program, rt);
  registerUpdate(program, rt);
  for (const c of program.commands) c.exitOverride().configureOutput({ writeOut: (s) => void deps.stdout.write(s), writeErr: (s) => void deps.stderr.write(s) });
  return program;
}

/** Runs the CLI with user arguments (without node/script) and returns the exit code. Never prints secret values. */
export async function main(args: string[], deps: CliDeps): Promise<number> {
  let exitCode: number = EXIT.ok;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(args, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // help / version → 0; anything else is a usage error (commander already printed it)
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof CliError) {
      deps.stderr.write(`asm: ${err.message}\n`);
      const help = (err as CliError & { help?: string }).help;
      if (help) deps.stderr.write(help);
      return err.exitCode;
    }
    if (err instanceof ApiError) {
      const hint = err.status === 401 ? ' (run: asm login <url>)' : '';
      deps.stderr.write(`asm: ${stripControl(err.code)}${hint}\n`);
      return EXIT.api;
    }
    if (err instanceof StoreError) {
      deps.stderr.write(`asm: ${err.message}\n`);
      return EXIT.api;
    }
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
      deps.stderr.write('asm: cannot reach the server\n');
      return EXIT.api;
    }
    deps.stderr.write(`asm: unexpected error (${(err as Error)?.name ?? 'unknown'})\n`);
    return EXIT.api;
  }
}
