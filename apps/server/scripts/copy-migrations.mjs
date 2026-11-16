// Copies the SQL migrations next to the compiled db/client.js (resolved relative to that module at runtime).
import { cpSync, rmSync } from 'node:fs';

const from = new URL('../src/db/migrations', import.meta.url);
const to = new URL('../dist/db/migrations', import.meta.url);
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
