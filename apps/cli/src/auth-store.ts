import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Tokens of one server (stored per server host). */
export type Credentials = { url: string; accessToken: string; refreshToken: string; expiresAt: number };

export interface TokenStore {
  get(host: string): Promise<Credentials | undefined>;
  /**
   * `replace` (login): store fresh credentials at the configured location and drop copies elsewhere.
   * Without it (refresh): update the credentials where they currently live.
   */
  set(host: string, creds: Credentials, opts?: { replace?: boolean }): Promise<void>;
  /** Returns true if something was deleted. */
  delete(host: string): Promise<boolean>;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

const KEYRING_SERVICE = 'asm';

/** ~/.config/asm (respects XDG_CONFIG_HOME). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'asm');
}

function parseCredentials(raw: unknown): Credentials | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.accessToken !== 'string' || typeof c.refreshToken !== 'string') return undefined;
  return {
    url: typeof c.url === 'string' ? c.url : '',
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : 0,
  };
}

/** Writes a file atomically with mode 0600 (exclusive, randomly named temp file; also tightens an existing file). */
export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let created = false;
  let renamed = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    renamed = true;
    chmodSync(path, 0o600);
  } finally {
    if (created && !renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // not created
      }
    }
  }
}

// ---------- in-memory (tests) ----------

export class MemoryStore implements TokenStore {
  readonly entries = new Map<string, Credentials>();
  async get(host: string) {
    return this.entries.get(host);
  }
  async set(host: string, creds: Credentials) {
    this.entries.set(host, { ...creds });
  }
  async delete(host: string) {
    return this.entries.delete(host);
  }
}

// ---------- OS keychain (via system tools; no native modules) ----------

export type RunResult = { code: number; stdout: string; stderr: string };
/**
 * Runs a system tool. `input` is written to stdin — secrets go there, never into argv (visible in `ps`).
 * Rejects with an error whose `code` is 'ENOENT' if the tool is missing.
 */
export type CommandRunner = (cmd: string, args: string[], input?: string) => Promise<RunResult>;

export const defaultRunner: CommandRunner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on('error', () => {
      // tool exited before reading stdin; the exit code reports the failure
    });
    child.stdin.end(input ?? '');
  });

const UNAVAILABLE_HINT = 'use --insecure-store to keep the tokens in ~/.config/asm/credentials.json (0600) instead';

function keychainError(what: string): StoreError {
  return new StoreError(`OS keychain ${what} (${UNAVAILABLE_HINT})`);
}

async function runTool(run: CommandRunner, cmd: string, args: string[], input?: string): Promise<RunResult> {
  try {
    return await run(cmd, args, input);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw keychainError(`unavailable: \`${cmd}\` not found`);
    throw keychainError(`access failed: \`${cmd}\` could not be started`);
  }
}

function parseStored(raw: string): Credentials | undefined {
  try {
    return parseCredentials(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Quotes an argument for the `security -i` command parser (double quotes, backslash-escaped `"` and `\`). */
export function securityQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new StoreError('value not storable in the OS keychain');
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** `security` exit code for "item not found" (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44;

/** macOS Keychain via /usr/bin/security (service `asm`, account = server host). */
export class MacKeychainStore implements TokenStore {
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  async get(host: string) {
    const r = await runTool(this.run, 'security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', host, '-w']);
    if (r.code === SECURITY_NOT_FOUND) return undefined;
    if (r.code !== 0) throw keychainError('access failed');
    let raw = r.stdout.replace(/\n$/, '');
    // `security -w` prints non-printable data as hex.
    if (/^([0-9a-f]{2})+$/.test(raw) && !raw.startsWith('{')) raw = Buffer.from(raw, 'hex').toString('utf8');
    return parseStored(raw);
  }

  async set(host: string, creds: Credentials) {
    // `security -i` reads the command from stdin, so the secret never appears in argv.
    const line = ['add-generic-password', '-U', '-s', securityQuote(KEYRING_SERVICE), '-a', securityQuote(host), '-w', securityQuote(JSON.stringify(creds))].join(' ');
    const r = await runTool(this.run, 'security', ['-i'], `${line}\n`);
    if (r.code !== 0) throw keychainError('access failed');
  }

  async delete(host: string) {
    const r = await runTool(this.run, 'security', ['delete-generic-password', '-s', KEYRING_SERVICE, '-a', host]);
    if (r.code === 0) return true;
    if (r.code === SECURITY_NOT_FOUND) return false;
    throw keychainError('access failed');
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet, …) via `secret-tool` from libsecret. */
export class SecretToolStore implements TokenStore {
  constructor(private readonly run: CommandRunner = defaultRunner) {}

  private attrs(host: string): string[] {
    return ['service', KEYRING_SERVICE, 'account', host];
  }

  async get(host: string) {
    const r = await runTool(this.run, 'secret-tool', ['lookup', ...this.attrs(host)]);
    if (r.code !== 0) {
      // Not found: exit 1 without output. Anything on stderr means the Secret Service failed.
      if (r.stderr.trim() === '') return undefined;
      throw keychainError('access failed');
    }
    return parseStored(r.stdout.replace(/\n$/, ''));
  }

  async set(host: string, creds: Credentials) {
    const r = await runTool(this.run, 'secret-tool', ['store', `--label=asm ${host}`, ...this.attrs(host)], JSON.stringify(creds));
    if (r.code !== 0) throw keychainError('access failed');
  }

  async delete(host: string) {
    // `secret-tool clear` does not report whether something was deleted.
    const existed = (await this.get(host)) !== undefined;
    const r = await runTool(this.run, 'secret-tool', ['clear', ...this.attrs(host)]);
    if (r.code !== 0 && r.stderr.trim() !== '') throw keychainError('access failed');
    return existed;
  }
}

/** Platform without a supported keychain tool. */
export class UnavailableKeychainStore implements TokenStore {
  private fail(): never {
    throw keychainError('not supported on this platform');
  }
  async get(_host: string): Promise<Credentials | undefined> {
    this.fail();
  }
  async set(_host: string, _creds: Credentials): Promise<void> {
    this.fail();
  }
  async delete(_host: string): Promise<boolean> {
    this.fail();
  }
}

export function createKeychainStore(platform: NodeJS.Platform = process.platform, run: CommandRunner = defaultRunner): TokenStore {
  if (platform === 'darwin') return new MacKeychainStore(run);
  if (platform === 'linux') return new SecretToolStore(run);
  return new UnavailableKeychainStore();
}

// ---------- plaintext file (--insecure-store) ----------

export class FileStore implements TokenStore {
  constructor(readonly path: string) {}

  private readAll(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw this.corrupt();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw this.corrupt();
    return data as Record<string, unknown>;
  }

  private corrupt(): StoreError {
    return new StoreError(`credentials_corrupt (delete ${this.path} and run asm login again)`);
  }

  async get(host: string) {
    return parseCredentials(this.readAll()[host]);
  }

  async set(host: string, creds: Credentials) {
    const all = this.readAll();
    all[host] = creds;
    writePrivateFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
  }

  async delete(host: string) {
    const all = this.readAll();
    if (!(host in all)) return false;
    delete all[host];
    writePrivateFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
    return true;
  }
}

/**
 * Default store: OS keyring. A login with --insecure-store keeps that host's tokens in the credentials file
 * (refreshes then update the file); a normal login moves the host back to the keyring and drops the file entry.
 */
export class DefaultStore implements TokenStore {
  constructor(
    private readonly keyring: TokenStore,
    private readonly file: TokenStore,
    private readonly insecure: boolean,
  ) {}

  async get(host: string) {
    if (this.insecure) return this.file.get(host);
    return (await this.file.get(host)) ?? this.keyring.get(host);
  }

  async set(host: string, creds: Credentials, opts: { replace?: boolean } = {}) {
    if (opts.replace) {
      if (this.insecure) return this.file.set(host, creds);
      await this.keyring.set(host, creds);
      await this.file.delete(host);
      return;
    }
    if (this.insecure || (await this.file.get(host))) return this.file.set(host, creds);
    return this.keyring.set(host, creds);
  }

  async delete(host: string) {
    const a = await this.file.delete(host);
    const b = this.insecure ? false : await this.keyring.delete(host).catch(() => false);
    return a || b;
  }
}

export function createDefaultStore(dir: string, insecure: boolean): TokenStore {
  return new DefaultStore(createKeychainStore(), new FileStore(join(dir, 'credentials.json')), insecure);
}

// ---------- non-secret config ----------

export type CliConfig = { defaultServer?: string };

export function readConfig(dir: string): CliConfig {
  try {
    const data = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    return typeof data.defaultServer === 'string' ? { defaultServer: data.defaultServer } : {};
  } catch {
    return {};
  }
}

export function writeConfig(dir: string, config: CliConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}
