import { rmSync } from 'node:fs';

/** Removes the mkdtemp data dir (test DB + server log) created in env.ts. */
export default function globalTeardown(): void {
  const dir = process.env.ASM_E2E_DATA_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
}
