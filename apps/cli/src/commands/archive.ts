import type { Command } from 'commander';
import { usage, type Runtime } from '../runtime.js';
import { stripControl } from '../sanitize.js';

export function registerArchive(program: Command, rt: () => Runtime): void {
  const cmd = program
    .command('archive')
    .description('Archive a secret that is no longer needed (no approval needed)')
    .argument('<secretId>', 'secret to archive')
    .option('--reason <text>', 'why (e.g. "replaced by sec_…") (required)')
    .option('--project <name>', 'project name (default: git repo / folder name)')
    .action(async (secretId: string, o: { reason?: string; project?: string }) => {
      if (!o.reason || o.reason.trim() === '') usage(cmd, '--reason is required');
      const r = rt();
      const meta = await r.api().archiveSecret(secretId, { reason: o.reason, project: r.project(o.project) });
      r.stdout.write(`${stripControl(meta.id)} archived\n`);
    });
}
