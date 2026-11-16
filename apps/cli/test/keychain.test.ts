import { describe, expect, it } from 'vitest';
import {
  createKeychainStore, MacKeychainStore, SecretToolStore, StoreError, UnavailableKeychainStore,
  type CommandRunner, type Credentials, type RunResult,
} from '../src/auth-store.js';
import { runCli } from './helpers.js';

const creds: Credentials = { url: 'https://asm.test', accessToken: 'asm_at_s3cr3t"\\q', refreshToken: 'asm_rt_s3cr3t', expiresAt: 42 };

type Call = { cmd: string; args: string[]; input?: string };

/** Fake `security` (interactive mode parses the double-quoted, backslash-escaped command line from stdin). */
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const unquote = (line: string) => {
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    for (let m; (m = re.exec(line)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
    return out;
  };
  const exec = (args: string[]): RunResult => {
    const opt = (f: string) => args[args.indexOf(f) + 1]!;
    const key = `${opt('-s')}/${opt('-a')}`;
    switch (args[0]) {
      case 'add-generic-password':
        items.set(key, opt('-w'));
        return { code: 0, stdout: '', stderr: '' };
      case 'find-generic-password':
        return items.has(key) ? { code: 0, stdout: `${items.get(key)}\n`, stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      case 'delete-generic-password':
        return items.delete(key) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      default:
        return { code: 1, stdout: '', stderr: 'unknown' };
    }
  };
  const run: CommandRunner = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (cmd !== 'security') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    if (args[0] === '-i') return exec(unquote(input!.trim()));
    return exec(args);
  };
  return { run, calls, items };
}

function fakeSecretTool() {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args, input) => {
    calls.push({ cmd, args, input });
    if (cmd !== 'secret-tool') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const attrs = args.filter((a) => !a.startsWith('--')).slice(1);
    const key = attrs.join('/');
    if (args[0] === 'store') {
      items.set(key, input!);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'lookup') return items.has(key) ? { code: 0, stdout: items.get(key)!, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'clear') {
      items.delete(key);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'usage' };
  };
  return { run, calls, items };
}

const missing: CommandRunner = async () => {
  throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
};

const secretInArgv = (calls: Call[]) => calls.some((c) => c.args.some((a) => a.includes('s3cr3t')));

describe('macOS keychain (security)', () => {
  it('stores via `security -i` on stdin, reads, deletes; the secret is never in argv', async () => {
    const f = fakeSecurity();
    const store = new MacKeychainStore(f.run);
    expect(await store.get('asm.test')).toBeUndefined();
    await store.set('asm.test', creds);
    await store.set('asm.test', { ...creds, accessToken: 'asm_at_s3cr3t2' });
    const add = f.calls.find((c) => c.args[0] === '-i')!;
    expect(add.args).toEqual(['-i']);
    expect(add.input).toContain('add-generic-password -U -s "asm" -a "asm.test" -w ');
    expect(f.items.get('asm/asm.test')).toBe(JSON.stringify({ ...creds, accessToken: 'asm_at_s3cr3t2' }));
    expect(await store.get('asm.test')).toEqual({ ...creds, accessToken: 'asm_at_s3cr3t2' });
    expect(f.calls.find((c) => c.args[0] === 'find-generic-password')!.args).toEqual(['find-generic-password', '-s', 'asm', '-a', 'asm.test', '-w']);
    expect(await store.delete('asm.test')).toBe(true);
    expect(await store.delete('asm.test')).toBe(false);
    expect(await store.get('asm.test')).toBeUndefined();
    expect(secretInArgv(f.calls)).toBe(false);
  });

  it('decodes hex output of `security -w`', async () => {
    const hex = Buffer.from(JSON.stringify({ ...creds, accessToken: 'äöü' })).toString('hex');
    const store = new MacKeychainStore(async () => ({ code: 0, stdout: `${hex}\n`, stderr: '' }));
    expect(await store.get('asm.test')).toMatchObject({ accessToken: 'äöü' });
  });

  it('failure exit codes → StoreError with --insecure-store hint', async () => {
    const store = new MacKeychainStore(async () => ({ code: 51, stdout: '', stderr: 'user interaction not allowed' }));
    await expect(store.get('asm.test')).rejects.toThrow(/--insecure-store/);
    await expect(store.set('asm.test', creds)).rejects.toThrow(StoreError);
  });
});

describe('Linux Secret Service (secret-tool)', () => {
  it('store reads the secret from stdin; lookup / clear; never in argv', async () => {
    const f = fakeSecretTool();
    const store = new SecretToolStore(f.run);
    await store.set('asm.test:8443', creds);
    expect(f.calls[0]).toEqual({ cmd: 'secret-tool', args: ['store', '--label=asm asm.test:8443', 'service', 'asm', 'account', 'asm.test:8443'], input: JSON.stringify(creds) });
    expect(await store.get('asm.test:8443')).toEqual(creds);
    expect(f.calls[1]!.args).toEqual(['lookup', 'service', 'asm', 'account', 'asm.test:8443']);
    expect(await store.delete('asm.test:8443')).toBe(true);
    expect(f.calls.at(-1)!.args).toEqual(['clear', 'service', 'asm', 'account', 'asm.test:8443']);
    expect(await store.delete('asm.test:8443')).toBe(false);
    expect(await store.get('asm.test:8443')).toBeUndefined();
    expect(secretInArgv(f.calls)).toBe(false);
  });

  it('Secret Service error (stderr) → StoreError, not "not logged in"', async () => {
    const store = new SecretToolStore(async () => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11' }));
    await expect(store.get('asm.test')).rejects.toThrow(/--insecure-store/);
  });
});

describe('keychain unavailable', () => {
  it('missing tool → StoreError mentioning --insecure-store', async () => {
    for (const store of [new MacKeychainStore(missing), new SecretToolStore(missing)]) {
      await expect(store.set('asm.test', creds)).rejects.toThrow(StoreError);
      await expect(store.get('asm.test')).rejects.toThrow(/not found.*--insecure-store/);
    }
    await expect(new UnavailableKeychainStore().set('asm.test', creds)).rejects.toThrow(/--insecure-store/);
  });

  it('picks the backend by platform', () => {
    expect(createKeychainStore('darwin', missing)).toBeInstanceOf(MacKeychainStore);
    expect(createKeychainStore('linux', missing)).toBeInstanceOf(SecretToolStore);
    expect(createKeychainStore('win32', missing)).toBeInstanceOf(UnavailableKeychainStore);
  });

  it('a command hitting the missing keychain exits 1 with the hint', async () => {
    const r = await runCli(['search', 'x', '--project', 'p'], { deps: { storeFor: () => new MacKeychainStore(missing) } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^asm: OS keychain unavailable: `security` not found \(use --insecure-store/);
  });
});
