import { existsSync, readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SAFE_ORIGIN } from './cli-dist/install-script.js';

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
  /** Clients outside these networks may only reach the public approval paths; null = no restriction. */
  trustedNetworks: Cidr[] | null;
  /** VAPID subject (mailto: or https: URL) sent to push services. */
  vapidSubject: string;
};

export type Cidr = { address: string; prefix: number; family: 'ipv4' | 'ipv6' };

export const DEFAULT_VAPID_SUBJECT = 'mailto:asm@localhost';

/** Parses a comma-separated list of IPv4/IPv6 CIDRs (a bare address means a single host). */
export function parseTrustedNetworks(raw: string | undefined): Cidr[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  return raw.split(',').map((part) => {
    const item = part.trim();
    const [address = '', prefixRaw, ...rest] = item.split('/');
    const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
    const max = family === 'ipv4' ? 32 : 128;
    if (!family || rest.length > 0 || (prefixRaw !== undefined && !/^\d{1,3}$/.test(prefixRaw))) {
      throw new ConfigError(`ASM_TRUSTED_NETWORKS contains an invalid CIDR: ${item}`);
    }
    const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
    if (prefix > max) throw new ConfigError(`ASM_TRUSTED_NETWORKS contains an invalid CIDR: ${item}`);
    return { address, prefix, family };
  });
}

function parseVapidSubject(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_VAPID_SUBJECT;
  const v = raw.trim();
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(v) && !/^https:\/\/\S+$/.test(v)) {
    throw new ConfigError('ASM_VAPID_SUBJECT must be a mailto: address or an https: URL');
  }
  return v;
}

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
  // The origin is embedded into /cli/install.sh; refuse anything beyond plain URL characters.
  if (!SAFE_ORIGIN.test(publicUrl.origin)) throw new ConfigError('ASM_PUBLIC_URL contains unsupported characters in its host');
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
    trustedNetworks: parseTrustedNetworks(env.ASM_TRUSTED_NETWORKS),
    vapidSubject: parseVapidSubject(env.ASM_VAPID_SUBJECT),
  };
}
