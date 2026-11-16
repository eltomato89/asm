import type { Command } from 'commander';
import type { Runtime } from '../runtime.js';

/** Plain text table with padded columns. */
export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(head), ...rows.map(line)].join('\n') + '\n';
}

export function registerSearch(program: Command, rt: () => Runtime): void {
  program
    .command('search')
    .description('Search secrets (metadata only)')
    .argument('[query]', 'search terms', '')
    .option('--archived', 'include archived secrets')
    .option('--vault <id>', 'restrict to one vault')
    .option('--project <name>', 'project name (default: git repo / folder name)')
    .action(async (query: string, o: { archived?: boolean; vault?: string; project?: string }) => {
      const r = rt();
      const { items } = await r.api().searchSecrets({ q: query, project: r.project(o.project), archived: o.archived, vault: o.vault });
      if (items.length === 0) {
        r.stderr.write('No secrets found.\n');
        return;
      }
      r.stdout.write(
        table(
          ['ID', 'TITLE', 'ENV', 'VAULT', 'ARCHIVED'],
          items.map((s) => [s.id, s.title, s.envName ?? '', s.vaultName, s.archived ? 'yes' : '']),
        ),
      );
    });
}
