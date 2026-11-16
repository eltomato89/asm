import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Config = {
  publicUrl: URL;
  masterKey: Buffer;
  trustProxy: boolean;
  autoModeMaxMin: number;
  dataDir: string;
  port: number;
  /** Directory with the CLI bundle (asm.mjs + asm.json) served under /cli; null = not available. */
  cliDir: string | null;
};

/** CLI bundle location inside the Docker image. */
export const IMAGE_CLI_DIR = '/app/cli';
/** Local CLI bundle (apps/cli/dist-bundle), relative to apps/server/{src,dist}. */
export const REPO_CLI_DIR = fileURLToPath(new URL('../../cli/dist-bundle', import.meta.url));

function defaultCliDir(exists: (p: string) => boolean): string | null {
  if (exists(IMAGE_CLI_DIR)) return IMAGE_CLI_DIR;
  if (exists(REPO_CLI_DIR)) return REPO_CLI_DIR;
  return null;
}

function parseKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim();
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== trimmed) {
    throw new ConfigError(`${source} must be base64 of exactly 32 bytes`);
  }
  return buf;
}

function parseInt10(raw: string | undefined, def: number, name: string): number {
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = existsSync,
): Config {
  let masterKey: Buffer;
  if (env.ASM_MASTER_KEY_FILE) {
    let content: string;
    try {
      content = readFile(env.ASM_MASTER_KEY_FILE);
    } catch {
      throw new ConfigError(`ASM_MASTER_KEY_FILE could not be read: ${env.ASM_MASTER_KEY_FILE}`);
    }
    masterKey = parseKey(content, 'ASM_MASTER_KEY_FILE');
  } else if (env.ASM_MASTER_KEY) {
    masterKey = parseKey(env.ASM_MASTER_KEY, 'ASM_MASTER_KEY');
  } else {
    throw new ConfigError('ASM_MASTER_KEY or ASM_MASTER_KEY_FILE is required');
  }

  if (!env.ASM_PUBLIC_URL) throw new ConfigError('ASM_PUBLIC_URL is required');
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.ASM_PUBLIC_URL);
  } catch {
    throw new ConfigError('ASM_PUBLIC_URL is not a valid URL');
  }
  if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
    throw new ConfigError('ASM_PUBLIC_URL must use http: or https:');
  }
  if (!publicUrl.hostname) throw new ConfigError('ASM_PUBLIC_URL must have a hostname');
  const isLocal = publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1';
  if (publicUrl.protocol === 'http:' && !isLocal) {
    throw new ConfigError('ASM_PUBLIC_URL must use https: (http: is only allowed for localhost/127.0.0.1)');
  }

  return {
    publicUrl,
    masterKey,
    trustProxy: env.ASM_TRUST_PROXY === 'true' || env.ASM_TRUST_PROXY === '1',
    autoModeMaxMin: parseInt10(env.ASM_AUTO_MODE_MAX_MIN, 240, 'ASM_AUTO_MODE_MAX_MIN'),
    dataDir: env.ASM_DATA_DIR || '/data',
    port: parseInt10(env.PORT, 8080, 'PORT'),
    cliDir: env.ASM_CLI_DIR || defaultCliDir(exists),
  };
}
