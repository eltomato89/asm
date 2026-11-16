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

// ---------- OS keyring ----------

type KeyringEntry = { getPassword(): string | null | undefined; setPassword(p: string): void; deletePassword(): boolean };

export class KeyringStore implements TokenStore {
  private entry(host: string): Promise<KeyringEntry> {
    return import('@napi-rs/keyring')
      .then((m) => new m.Entry(KEYRING_SERVICE, host) as KeyringEntry)
      .catch(() => {
        throw new StoreError('OS keyring unavailable (use --insecure-store)');
      });
  }

  private async attempt<T>(fn: () => T): Promise<T> {
    try {
      return fn();
    } catch {
      throw new StoreError('OS keyring access failed (use --insecure-store)');
    }
  }

  async get(host: string) {
    const e = await this.entry(host);
    const raw = await this.attempt(() => {
      try {
        return e.getPassword();
      } catch (err) {
        // "No entry" is reported as an error by some platforms.
        if (/no (matching )?entry|not found/i.test(String((err as Error)?.message))) return null;
        throw err;
      }
    });
    if (!raw) return undefined;
    try {
      return parseCredentials(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async set(host: string, creds: Credentials) {
    const e = await this.entry(host);
    await this.attempt(() => e.setPassword(JSON.stringify(creds)));
  }

  async delete(host: string) {
    const e = await this.entry(host);
    try {
      return e.deletePassword();
    } catch {
      return false;
    }
  }
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
  return new DefaultStore(new KeyringStore(), new FileStore(join(dir, 'credentials.json')), insecure);
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
