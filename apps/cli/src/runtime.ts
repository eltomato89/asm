import { execFileSync, type StdioOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { ApiError, createApiClient, type ApiClient, type CliRequestDto } from '@asm/shared/api-client';
import { createDefaultStore, readConfig, type TokenStore } from './auth-store.js';
import { acquireLock, LOCK_STALE_MS } from './lock.js';

/** Refresh proactively when the access token expires within this window. */
export const REFRESH_AHEAD_MS = 60_000;
/** Timeout of the refresh call; below the lock's stale age so a hanging refresh never outlives its lock. */
export const REFRESH_TIMEOUT_MS = 20_000;

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
  /** Whether stdin is a terminal (`--from-stdin` refuses; `asm run` then leaves SIGINT to the process group). */
  stdinIsTTY?: boolean;
  /** Timeout of the token refresh call (default REFRESH_TIMEOUT_MS). */
  refreshTimeoutMs?: number;
  /** Source of SIGINT/SIGTERM/SIGHUP for `asm run` forwarding (default: process). */
  signals?: NodeJS.EventEmitter;
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

  /** Authenticated client for the current server; refreshes proactively (≤60 s left) and once on 401. */
  api(): ApiClient {
    if (this.apiClient) return this.apiClient;
    const server = this.server();
    if (this.deps.makeApi) return (this.apiClient = this.deps.makeApi(server));
    const host = serverHost(server);
    let lastToken: string | undefined;
    const client: ApiClient = createApiClient({
      baseUrl: server,
      fetch: this.deps.fetch,
      getAccessToken: async () => {
        let creds = await this.store.get(host);
        if (creds && creds.expiresAt > 0 && creds.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
          await this.refreshTokens(client, server, creds.accessToken);
          creds = await this.store.get(host);
        }
        lastToken = creds?.accessToken;
        return lastToken;
      },
      onUnauthorized: () => this.refreshTokens(client, server, lastToken),
    });
    return (this.apiClient = client);
  }

  /**
   * Rotates the tokens under a cross-process lock: the server treats reuse of a rotated refresh token as theft and
   * revokes the device, so concurrent `asm` processes must not refresh with the same token. If another process
   * already refreshed (stored access token differs from `staleAccess`), its tokens are used instead.
   */
  private async refreshTokens(client: ApiClient, server: string, staleAccess: string | undefined): Promise<boolean> {
    const host = serverHost(server);
    mkdirSync(this.deps.configDir, { recursive: true, mode: 0o700 });
    const release = await acquireLock(join(this.deps.configDir, `refresh-${host.replace(/[^A-Za-z0-9.-]/g, '_')}.lock`));
    try {
      const creds = await this.store.get(host);
      if (!creds) return false;
      if (staleAccess !== undefined && creds.accessToken !== staleAccess) return true;
      let t;
      try {
        t = await client.token({ grant_type: 'refresh_token', refresh_token: creds.refreshToken }, { signal: AbortSignal.timeout(Math.min(this.deps.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS, LOCK_STALE_MS - 10_000)) });
      } catch (err) {
        if (err instanceof ApiError) return false;
        if ((err as Error)?.name === 'TimeoutError') throw new CliError(EXIT.api, 'refresh_timeout');
        throw err;
      }
      try {
        await this.store.set(host, { url: server, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });
      } catch {
        // The old refresh token is now rotated: without the new one this device needs a fresh login.
        throw new CliError(EXIT.api, 'token_store_failed');
      }
      return true;
    } finally {
      release();
    }
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
