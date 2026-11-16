import type { Command } from 'commander';
import { usage, type Runtime } from '../runtime.js';

export function registerRequest(program: Command, rt: () => Runtime): void {
  const cmd = program
    .command('request')
    .description('Request access to a secret; prints the request id and, once approved, the grant id')
    .argument('<secretId>', 'secret to request')
    .option('--reason <text>', 'reason (required)')
    .option('--project <name>', 'project name (default: git repo / folder name)')
    .option('--wait', 'wait for the decision')
    .action(async (secretId: string, o: { reason?: string; project?: string; wait?: boolean }) => {
      if (!o.reason || o.reason.trim() === '') usage(cmd, '--reason is required');
      const r = rt();
      const dto = await r.api().createRequest({ secretId, project: r.project(o.project), reason: o.reason });
      r.stdout.write(`${dto.id}\n`);
      if (dto.status === 'pending' && !o.wait) {
        r.stderr.write('Pending approval; re-run with --wait or approve it in ASM.\n');
        return;
      }
      const done = await r.awaitDecision(dto);
      if (done.grantId) r.stdout.write(`${done.grantId}\n`);
    });
}
