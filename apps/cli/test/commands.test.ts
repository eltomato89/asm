import { describe, expect, it } from 'vitest';
import { ApiError } from '@asm/shared/api-client';
import { MemoryStore, readConfig } from '../src/auth-store.js';
import { fakeApi, requestDto, runCli, SERVER } from './helpers.js';

const pending = () => {
  throw new ApiError(400, 'authorization_pending');
};

describe('asm login', () => {
  it('device flow: prints code + url to stderr, honors interval and slow_down, stores tokens, sets default server', async () => {
    const sleeps: number[] = [];
    const responses: (() => unknown)[] = [
      pending,
      () => {
        throw new ApiError(400, 'slow_down');
      },
      () => ({ access_token: 'asm_at_x', refresh_token: 'asm_rt_x', expires_in: 3600, token_type: 'Bearer' }),
    ];
    const api = fakeApi({
      deviceAuthorization: async () => ({ device_code: 'dc', user_code: 'BCDF-GHJK', verification_uri: 'https://new.test/activate', expires_in: 600, interval: 5 }),
      token: async () => responses.shift()!(),
    });
    const r = await runCli(['login', 'https://new.test/'], { api, deps: { sleep: async (ms) => void sleeps.push(ms) } });
    expect(r.code).toBe(0);
    expect(r.err).toContain('Open https://new.test/activate and enter code BCDF-GHJK');
    expect(api.deviceAuthorization).toHaveBeenCalledWith({ client_name: 'asm-cli', hostname: 'test-host' });
    expect(api.token).toHaveBeenCalledWith({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc' });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(await r.store.get('new.test')).toMatchObject({ url: 'https://new.test', accessToken: 'asm_at_x', refreshToken: 'asm_rt_x' });
    expect(readConfig(r.configDir).defaultServer).toBe('https://new.test');
    expect(r.out + r.err).not.toContain('asm_at_x');
  });

  it('access_denied / expired_token → exit 3', async () => {
    for (const code of ['access_denied', 'expired_token']) {
      const api = fakeApi({
        deviceAuthorization: async () => ({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 600, interval: 5 }),
        token: async () => {
          throw new ApiError(400, code);
        },
      });
      expect((await runCli(['login', 'https://new.test'], { api })).code).toBe(3);
    }
  });

  it('gives up after the device code lifetime', async () => {
    const api = fakeApi({
      deviceAuthorization: async () => ({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 10, interval: 5 }),
      token: async () => pending(),
    });
    expect((await runCli(['login', 'https://new.test'], { api })).code).toBe(3);
    expect(api.token).toHaveBeenCalledTimes(2);
  });
});

describe('token refresh', () => {
  it('refreshes with grant_type refresh_token on 401, stores the new tokens and retries', async () => {
    const calls: { url: string; body?: string; auth?: string | null }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ url, body: init.body as string | undefined, auth });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (url.endsWith('/oauth/token')) return json(200, { access_token: 'asm_at_new', refresh_token: 'asm_rt_new', expires_in: 3600, token_type: 'Bearer' });
      return auth === 'Bearer asm_at_new' ? json(200, { items: [] }) : json(401, { error: 'invalid_token' });
    }) as unknown as typeof globalThis.fetch;
    const store = new MemoryStore();
    await store.set('asm.test', { url: SERVER, accessToken: 'asm_at_old', refreshToken: 'asm_rt_old', expiresAt: 0 });
    const r = await runCli(['search', 'x', '--project', 'p'], { deps: { fetch, storeFor: () => store } });
    expect(r.code).toBe(0);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'asm_rt_old' });
    expect(calls[2]!.auth).toBe('Bearer asm_at_new');
    expect(await store.get('asm.test')).toMatchObject({ accessToken: 'asm_at_new', refreshToken: 'asm_rt_new' });
  });

  it('failed refresh → exit 1 with a login hint', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })) as unknown as typeof globalThis.fetch;
    const r = await runCli(['search', 'x', '--project', 'p'], { deps: { fetch } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('asm: unauthenticated');
  });
});

describe('hardening', () => {
  it('login refuses plain http for non-local hosts unless --allow-http; localhost is fine', async () => {
    const da = async () => ({ device_code: 'dc', user_code: 'U', verification_uri: 'v', expires_in: 600, interval: 5 });
    const tok = async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' });
    const api = fakeApi({ deviceAuthorization: da, token: tok });
    const r = await runCli(['login', 'http://asm.example.com'], { api });
    expect(r.code).toBe(2);
    expect(api.deviceAuthorization).not.toHaveBeenCalled();
    expect((await runCli(['login', 'http://asm.example.com', '--allow-http'], { api: fakeApi({ deviceAuthorization: da, token: tok }) })).code).toBe(0);
    expect((await runCli(['login', 'http://localhost:8080'], { api: fakeApi({ deviceAuthorization: da, token: tok }) })).code).toBe(0);
  });

  it('strips terminal control characters from server-supplied strings (login, search)', async () => {
    const api = fakeApi({
      deviceAuthorization: async () => ({ device_code: 'dc', user_code: 'AB\x1b]0;pwned\x07CD', verification_uri: 'https://x.test/\x1b[2Jactivate', expires_in: 600, interval: 5 }),
      token: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }),
    });
    const r = await runCli(['login', 'https://x.test'], { api });
    expect(r.err).toContain('Open https://x.test/activate and enter code ABCD');
    expect(r.err).not.toContain('\x1b');
    const s = fakeApi({
      searchSecrets: async () => ({
        items: [{ id: 'sec_1', title: 'Evil\x1b[31m\r\nfake\x9b', envName: null, vaultName: 'V\x07', archived: null }],
      }),
    });
    const out = (await runCli(['search', '--project', 'p'], { api: s })).out;
    expect(out).toContain('Evilfake');
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('--from-stdin refuses an interactive terminal (exit 2)', async () => {
    const api = fakeApi();
    const r = await runCli(['set', 'sec_1', '--project', 'p', '--reason', 'r', '--from-stdin'], { api, deps: { stdinIsTTY: true } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--from-env');
    expect(api.updateSecret).not.toHaveBeenCalled();
  });
});

describe('other commands', () => {
  it('search prints a table (id, title, env, vault, archived) and passes --archived', async () => {
    const meta = (id: string, title: string, envName: string | null, archived: boolean) => ({
      id, title, envName, vaultId: 'vlt_1', vaultName: 'Personal', description: '', tags: [], allowPlaintextToAgent: false, updatedAt: 0,
      archived: archived ? { at: 0, by: { type: 'user', id: 'u', name: 'alice' }, reason: 'old', project: null } : null,
    });
    const api = fakeApi({ searchSecrets: async () => ({ items: [meta('sec_1', 'GitHub', 'GITHUB_TOKEN', false), meta('sec_2', 'Old', null, true)] }) });
    const r = await runCli(['search', 'git', '--archived', '--project', 'p'], { api });
    expect(r.code).toBe(0);
    expect(api.searchSecrets).toHaveBeenCalledWith({ q: 'git', project: 'p', archived: true, vault: undefined });
    expect(r.out.split('\n')).toEqual([
      'ID     TITLE   ENV           VAULT     ARCHIVED',
      'sec_1  GitHub  GITHUB_TOKEN  Personal',
      'sec_2  Old                   Personal  yes',
      '',
    ]);
  });

  it('request --wait prints request id and grant id; denied → 3', async () => {
    const api = fakeApi({ createRequest: async () => requestDto(), waitRequest: async () => requestDto({ status: 'approved', grantId: 'grt_X' }) });
    const r = await runCli(['request', 'sec_1', '--reason', 'deploy', '--project', 'p', '--wait'], { api });
    expect(r.out).toBe('req_1\ngrt_X\n');
    expect(r.err).toContain('Waiting for approval…');
    const denied = fakeApi({ createRequest: async () => requestDto(), waitRequest: async () => requestDto({ status: 'denied' }) });
    expect((await runCli(['request', 'sec_1', '--reason', 'deploy', '--wait'], { api: denied })).code).toBe(3);
    expect((await runCli(['request', 'sec_1'], { api })).code).toBe(2);
  });

  it('request without --wait prints the grant id at once when auto-approved', async () => {
    const api = fakeApi({ createRequest: async () => requestDto({ status: 'approved', auto: true, grantId: 'grt_A' }) });
    expect((await runCli(['request', 'sec_1', '--reason', 'r', '--project', 'p'], { api })).out).toBe('req_1\ngrt_A\n');
  });

  it('archive requires --reason and sends project', async () => {
    const api = fakeApi({ archiveSecret: async () => ({ id: 'sec_1' }) });
    expect((await runCli(['archive', 'sec_1', '--project', 'p'], { api })).code).toBe(2);
    const r = await runCli(['archive', 'sec_1', '--reason', 'replaced by sec_2', '--project', 'p'], { api });
    expect(r.code).toBe(0);
    expect(api.archiveSecret).toHaveBeenCalledWith('sec_1', { reason: 'replaced by sec_2', project: 'p' });
    expect(r.out).toBe('sec_1 archived\n');
  });

  it('mcp-config prints the claude command; --server overrides the default', async () => {
    expect((await runCli(['mcp-config'])).out).toBe(`claude mcp add --transport http asm ${SERVER}/mcp\n`);
    expect((await runCli(['--server', 'https://other.test/x', 'mcp-config'])).out).toBe('claude mcp add --transport http asm https://other.test/mcp\n');
  });

  it('logout deletes the stored tokens', async () => {
    const store = new MemoryStore();
    await store.set('asm.test', { url: SERVER, accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
    const r = await runCli(['logout'], { deps: { storeFor: () => store } });
    expect(r.code).toBe(0);
    expect(await store.get('asm.test')).toBeUndefined();
  });

  it('unknown command / option → exit 2', async () => {
    expect((await runCli(['frobnicate'])).code).toBe(2);
    expect((await runCli(['search', '--bogus'])).code).toBe(2);
    expect((await runCli(['--help'])).code).toBe(0);
  });
});
