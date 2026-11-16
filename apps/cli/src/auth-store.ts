import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Tokens of one server (stored per server host). */
export type Credentials = { url: string; accessToken: string; refreshToken: string; expiresAt: number };

export interface TokenStore {
  get(host: string): Promise<Credentials | undefined>;
  set(host: string, creds: Credentials): Promise<void>;
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

/** Writes a file atomically with mode 0600 (also tightens an existing file). */
export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
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
 * Default store: OS keyring; the credentials file is only written with --insecure-store.
 * Reads fall back to the file so tokens stored with --insecure-store keep working (and refresh in place).
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

  async set(host: string, creds: Credentials) {
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
