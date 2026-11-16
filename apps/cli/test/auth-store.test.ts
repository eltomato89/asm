import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultStore, FileStore, MemoryStore, StoreError, writePrivateFile, type Credentials } from '../src/auth-store.js';
import { runCli, tmp } from './helpers.js';

const creds = (n: string): Credentials => ({ url: 'https://asm.test', accessToken: `asm_at_${n}`, refreshToken: `asm_rt_${n}`, expiresAt: 0 });

describe('auth store', () => {
  it('writePrivateFile: mode 0600, no temp files left behind (also on failure)', () => {
    const dir = tmp();
    const file = join(dir, 'f.json');
    writePrivateFile(file, 'x');
    writeFileSync(file, 'y', { mode: 0o644 });
    writePrivateFile(file, 'z');
    expect(readFileSync(file, 'utf8')).toBe('z');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['f.json']);
    // Target is a directory → rename fails; the temp file is removed.
    expect(() => writePrivateFile(dir, 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['f.json']);
  });

  it('login without --insecure-store goes to the keyring and drops the file entry; insecure hosts refresh in-file', async () => {
    const dir = tmp();
    const keyring = new MemoryStore();
    const file = new FileStore(join(dir, 'credentials.json'));
    await new DefaultStore(keyring, file, true).set('a.test', creds('1'), { replace: true });
    expect(await file.get('a.test')).toMatchObject({ accessToken: 'asm_at_1' });
    // refresh from a normal (not --insecure-store) invocation stays in the file
    const normal = new DefaultStore(keyring, file, false);
    await normal.set('a.test', creds('2'));
    expect(await file.get('a.test')).toMatchObject({ accessToken: 'asm_at_2' });
    expect(keyring.entries.size).toBe(0);
    // a normal login moves it to the keyring
    await normal.set('a.test', creds('3'), { replace: true });
    expect(await file.get('a.test')).toBeUndefined();
    expect(await keyring.get('a.test')).toMatchObject({ accessToken: 'asm_at_3' });
    expect(await normal.get('a.test')).toMatchObject({ accessToken: 'asm_at_3' });
  });

  it('corrupt credentials file → StoreError credentials_corrupt → exit 1', async () => {
    const dir = tmp();
    const path = join(dir, 'credentials.json');
    writeFileSync(path, '{not json');
    await expect(new FileStore(path).get('a.test')).rejects.toThrow(StoreError);
    const r = await runCli(['logout'], { deps: { storeFor: () => new FileStore(path) } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: credentials_corrupt\n');
    expect(existsSync(path)).toBe(true);
  });
});
