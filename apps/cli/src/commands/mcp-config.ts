import type { Command } from 'commander';
import type { Runtime } from '../runtime.js';

export function registerMcpConfig(program: Command, rt: () => Runtime): void {
  program
    .command('mcp-config')
    .description('Print the command that adds ASM as an MCP server to Claude Code')
    .action(() => {
      const r = rt();
      r.stdout.write(`claude mcp add --transport http asm ${r.server()}/mcp\n`);
    });
}
