import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { ApiClient } from '@asm/shared/api-client';
import { MemoryStore, writeConfig } from '../src/auth-store.js';
import { main } from '../src/cli.js';
import type { CliDeps } from '../src/runtime.js';

export const SERVER = 'https://asm.test';

export function tmp(prefix = 'asm-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export type FakeApi = { [K in keyof ApiClient]: ReturnType<typeof vi.fn> };

export function fakeApi(overrides: Partial<Record<keyof ApiClient, (...args: never[]) => unknown>> = {}): FakeApi {
  const names: (keyof ApiClient)[] = [
    'request', 'deviceAuthorization', 'token', 'redeemGrant', 'createRequest', 'waitRequest', 'createSecret', 'updateSecret', 'archiveSecret', 'searchSecrets',
  ];
  const api = {} as FakeApi;
  for (const n of names) api[n] = vi.fn(overrides[n] ?? (async () => { throw new Error(`unexpected call ${n}`); }));
  return api;
}

/** Runs the CLI in-process with captured output, an in-memory token store and a fake API client. */
export async function runCli(args: string[], o: { api?: FakeApi; env?: NodeJS.ProcessEnv; cwd?: string; deps?: Partial<CliDeps>; stdin?: string } = {}) {
  let out = '';
  let err = '';
  const configDir = o.deps?.configDir ?? tmp('asm-config-');
  writeConfig(configDir, { defaultServer: SERVER });
  const store = new MemoryStore();
  const deps: CliDeps = {
    env: o.env ?? {},
    cwd: o.cwd ?? tmp(),
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    readStdin: async () => o.stdin ?? '',
    configDir,
    hostname: 'test-host',
    storeFor: () => store,
    makeApi: o.api ? () => o.api as unknown as ApiClient : undefined,
    sleep: async () => {},
    ...o.deps,
  };
  const code = await main(args, deps);
  return { code, out, err, store, configDir };
}

export const requestDto = (over: Record<string, unknown> = {}) => ({
  id: 'req_1',
  kind: 'read',
  status: 'pending',
  secret: { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultId: 'vlt_1', vaultName: 'Personal' },
  device: { id: 'dev_1', name: 'asm-cli', kind: 'cli' },
  project: 'p',
  reason: 'r',
  delivery: 'cli',
  auto: false,
  decidedBy: null,
  createdAt: 0,
  decidedAt: null,
  expiresAt: 0,
  ...over,
});
