import { execFileSync, type StdioOptions } from 'node:child_process';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { ApiError, createApiClient, type ApiClient, type CliRequestDto } from '@asm/shared/api-client';
import { createDefaultStore, readConfig, type TokenStore } from './auth-store.js';

export type Out = { write(chunk: string): unknown };

/** Everything the commands touch outside their arguments (injectable for tests). */
export type CliDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Out;
  stderr: Out;
  readStdin: () => Promise<string>;
  configDir: string;
  hostname: string;
  /** Token store; default: OS keyring (file with --insecure-store). */
  storeFor?: (insecure: boolean) => TokenStore;
  /** API client factory; default: createApiClient with token refresh. */
  makeApi?: (server: string) => ApiClient;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** stdio of `asm run` children (default 'inherit'). */
  childStdio?: StdioOptions;
};

export const EXIT = { ok: 0, api: 1, usage: 2, denied: 3 } as const;

/** Ends the command with an exit code and a message (printed as `asm: <message>`). */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Usage error (exit 2): prints the command's help after the message. */
export function usage(cmd: Command | undefined, message: string): never {
  throw Object.assign(new CliError(EXIT.usage, message), { help: cmd?.helpInformation() });
}

export type GlobalOptions = { server?: string; insecureStore?: boolean };

/** Normalizes a server URL to its origin (http/https only). */
export function normalizeServer(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CliError(EXIT.usage, `invalid server url: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CliError(EXIT.usage, `invalid server url: ${url}`);
  return u.origin;
}

export const serverHost = (server: string) => new URL(server).host;

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class Runtime {
  readonly store: TokenStore;
  private apiClient: ApiClient | undefined;

  constructor(
    readonly deps: CliDeps,
    readonly globals: GlobalOptions,
  ) {
    this.store = (deps.storeFor ?? ((insecure) => createDefaultStore(deps.configDir, insecure)))(globals.insecureStore === true);
  }

  get stdout() {
    return this.deps.stdout;
  }
  get stderr() {
    return this.deps.stderr;
  }

  sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** --server, else the default server from `asm login`. */
  server(): string {
    const s = this.globals.server ?? readConfig(this.deps.configDir).defaultServer;
    if (!s) throw new CliError(EXIT.usage, 'no server configured (run: asm login <url>, or pass --server <url>)');
    return normalizeServer(s);
  }

  /** Unauthenticated client for a given server (OAuth endpoints). */
  publicApi(server: string): ApiClient {
    return this.deps.makeApi?.(server) ?? createApiClient({ baseUrl: server, getAccessToken: () => undefined, fetch: this.deps.fetch });
  }

  /** Authenticated client for the current server; refreshes the tokens once on 401. */
  api(): ApiClient {
    if (this.apiClient) return this.apiClient;
    const server = this.server();
    if (this.deps.makeApi) return (this.apiClient = this.deps.makeApi(server));
    const host = serverHost(server);
    const client: ApiClient = createApiClient({
      baseUrl: server,
      fetch: this.deps.fetch,
      getAccessToken: async () => (await this.store.get(host))?.accessToken,
      onUnauthorized: async () => {
        const creds = await this.store.get(host);
        if (!creds) return false;
        try {
          const t = await client.token({ grant_type: 'refresh_token', refresh_token: creds.refreshToken });
          await this.store.set(host, { url: server, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });
          return true;
        } catch (err) {
          if (err instanceof ApiError) return false;
          throw err;
        }
      },
    });
    return (this.apiClient = client);
  }

  /** --project, else basename of the git toplevel, else basename of the working directory. */
  project(explicit?: string): string {
    if (explicit !== undefined) {
      if (explicit.trim() === '') throw new CliError(EXIT.usage, '--project must not be empty');
      return explicit;
    }
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: this.deps.cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
      if (top) return basename(top);
    } catch {
      // not a git repository (or git missing)
    }
    return basename(this.deps.cwd);
  }

  /** Long-polls a request created by this device until it is decided; denied/expired → exit 3. */
  async awaitDecision(dto: CliRequestDto): Promise<CliRequestDto> {
    let cur = dto;
    if (cur.status === 'pending') this.stderr.write('Waiting for approval…\n');
    while (cur.status === 'pending') cur = await this.api().waitRequest(cur.id);
    if (cur.status !== 'approved') throw new CliError(EXIT.denied, `request ${cur.id} ${cur.status}`);
    return cur;
  }
}
