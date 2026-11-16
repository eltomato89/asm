import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const key = Buffer.alloc(32, 1).toString('base64');
const base = { ASM_PUBLIC_URL: 'https://asm.test', ASM_MASTER_KEY: key };

describe('loadConfig', () => {
  it('throws ConfigError mentioning ASM_MASTER_KEY when no key given', () => {
    expect(() => loadConfig({ ASM_PUBLIC_URL: 'https://asm.test' })).toThrow(ConfigError);
    expect(() => loadConfig({ ASM_PUBLIC_URL: 'https://asm.test' })).toThrow(/ASM_MASTER_KEY/);
  });
  it('rejects a 31 byte key', () => {
    const bad = Buffer.alloc(31, 1).toString('base64');
    expect(() => loadConfig({ ...base, ASM_MASTER_KEY: bad })).toThrow(ConfigError);
  });
  it('does not leak key material in the error', () => {
    const bad = Buffer.alloc(31, 1).toString('base64');
    try {
      loadConfig({ ...base, ASM_MASTER_KEY: bad });
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
    }
  });
  it('reads and trims ASM_MASTER_KEY_FILE', () => {
    const cfg = loadConfig(
      { ASM_PUBLIC_URL: 'https://asm.test', ASM_MASTER_KEY_FILE: '/run/key' },
      (p) => {
        expect(p).toBe('/run/key');
        return `  ${key}\n`;
      },
    );
    expect(cfg.masterKey.equals(Buffer.alloc(32, 1))).toBe(true);
  });
  it('requires ASM_PUBLIC_URL', () => {
    expect(() => loadConfig({ ASM_MASTER_KEY: key })).toThrow(/ASM_PUBLIC_URL/);
  });
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8080);
    expect(cfg.autoModeMaxMin).toBe(240);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.dataDir).toBe('/data');
    expect(cfg.publicUrl.origin).toBe('https://asm.test');
  });
  it('parses overrides', () => {
    const cfg = loadConfig({
      ...base,
      PORT: '9000',
      ASM_AUTO_MODE_MAX_MIN: '60',
      ASM_TRUST_PROXY: 'true',
      ASM_DATA_DIR: '/tmp/x',
    });
    expect(cfg).toMatchObject({ port: 9000, autoModeMaxMin: 60, trustProxy: true, dataDir: '/tmp/x' });
  });
  describe('ASM_PUBLIC_URL hardening', () => {
    const withUrl = (u: string) => () => loadConfig({ ...base, ASM_PUBLIC_URL: u });
    it('rejects non-http(s) schemes', () => {
      expect(withUrl('ftp://asm.test')).toThrow(ConfigError);
      expect(withUrl('file:///etc/passwd')).toThrow(ConfigError);
    });
    it('rejects http for non-local hosts', () => {
      expect(withUrl('http://asm.test')).toThrow(/https/);
    });
    it('allows http for localhost and 127.0.0.1, https anywhere', () => {
      expect(withUrl('http://localhost:8080')).not.toThrow();
      expect(withUrl('http://127.0.0.1:8080')).not.toThrow();
      expect(withUrl('https://asm.example.com')).not.toThrow();
    });
  });
});

describe('loadConfig: push approval settings', () => {
  it('defaults: no network gate, mailto:asm@localhost subject', () => {
    const cfg = loadConfig(base);
    expect(cfg.trustedNetworks).toBeNull();
    expect(cfg.vapidSubject).toBe('mailto:asm@localhost');
  });
  it('parses IPv4/IPv6 CIDRs and bare addresses', () => {
    const cfg = loadConfig({ ...base, ASM_TRUSTED_NETWORKS: '192.168.0.0/16, 100.64.0.0/10,fd00::/8,10.0.0.1' });
    expect(cfg.trustedNetworks).toEqual([
      { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
      { address: '100.64.0.0', prefix: 10, family: 'ipv4' },
      { address: 'fd00::', prefix: 8, family: 'ipv6' },
      { address: '10.0.0.1', prefix: 32, family: 'ipv4' },
    ]);
  });
  it('rejects invalid CIDRs', () => {
    for (const bad of ['192.168.0.0/33', 'fd00::/129', 'nope', '10.0.0.0/8/1', '10.0.0.0/x', '192.168.0.0/16,,']) {
      expect(() => loadConfig({ ...base, ASM_TRUSTED_NETWORKS: bad }), bad).toThrow(/ASM_TRUSTED_NETWORKS/);
    }
  });
  it('accepts mailto:/https: VAPID subjects only', () => {
    expect(loadConfig({ ...base, ASM_VAPID_SUBJECT: 'mailto:me@example.org' }).vapidSubject).toBe('mailto:me@example.org');
    expect(loadConfig({ ...base, ASM_VAPID_SUBJECT: 'https://asm.example.org' }).vapidSubject).toBe('https://asm.example.org');
    expect(() => loadConfig({ ...base, ASM_VAPID_SUBJECT: 'http://x' })).toThrow(/ASM_VAPID_SUBJECT/);
  });
  it('ASM_TRUST_PROXY: false, hop count, proxy list, legacy true', () => {
    const tp = (v?: string, extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra, ...(v === undefined ? {} : { ASM_TRUST_PROXY: v }) }).trustProxy;
    expect(tp()).toBe(false);
    expect(tp('false')).toBe(false);
    expect(tp('0')).toBe(false);
    expect(tp('1')).toBe(1);
    expect(tp('2')).toBe(2);
    expect(tp('true')).toBe(true);
    expect(tp('172.18.0.0/16, 10.0.0.2')).toBe('172.18.0.0/16,10.0.0.2/32');
    expect(() => tp('yes')).toThrow(/ASM_TRUST_PROXY/);
    expect(tp('1', { ASM_TRUSTED_NETWORKS: '192.168.0.0/16' })).toBe(1);
    expect(() => tp('true', { ASM_TRUSTED_NETWORKS: '192.168.0.0/16' })).toThrow(/hop/);
  });
});
