#!/usr/bin/env node
import { hostname } from 'node:os';
import { configDir } from './auth-store.js';
import { main } from './cli.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin,
  configDir: configDir(),
  hostname: hostname(),
  stdinIsTTY: process.stdin.isTTY === true,
});
