import { describe, expect, it } from 'vitest';
import { MemoryStore, type Credentials } from '../src/auth-store.js';
import { runCli, SERVER, tmp } from './helpers.js';

/** Fake ASM server with rotating refresh tokens and reuse detection (like oauth/token.ts). */
function fakeServer(initial: { access: string; refresh: string }) {
  const state = { ...initial, tokenCalls: 0, revoked: false, n: 0 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      state.tokenCalls++;
      const body = JSON.parse(String(init.body)) as { refresh_token: string };
      await new Promise((r) => setTimeout(r, 50));
      if (state.revoked || body.refresh_token !== state.refresh) {
        state.revoked = true;
        return json(400, { error: 'invalid_grant' });
      }
      state.n++;
      state.access = `asm_at_${state.n}`;
      state.refresh = `asm_rt_${state.n}`;
      return json(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer' });
    }
    const auth = new Headers(init.headers).get('authorization');
    return !state.revoked && auth === `Bearer ${state.access}` ? json(200, { items: [] }) : json(401, { error: 'invalid_token' });
  }) as unknown as typeof globalThis.fetch;
  return { state, fetch };
}

const stored = (over: Partial<Credentials> = {}): Credentials => ({
  url: SERVER, accessToken: 'asm_at_old', refreshToken: 'asm_rt_0', expiresAt: Date.now() + 3600_000, ...over,
});

describe('token refresh', () => {
  it('two concurrent asm processes hitting 401 refresh exactly once (no refresh-token reuse → no revocation)', async () => {
    const { state, fetch } = fakeServer({ access: 'asm_at_server_only', refresh: 'asm_rt_0' });
    const store = new MemoryStore();
    await store.set('asm.test', stored());
    const configDir = tmp();
    const deps = { fetch, storeFor: () => store, configDir };
    const [a, b] = await Promise.all([runCli(['search', '--project', 'p'], { deps }), runCli(['search', '--project', 'p'], { deps })]);
    expect([a.code, b.code, a.err, b.err]).toEqual([0, 0, 'No secrets found.\n', 'No secrets found.\n']);
    expect(state.tokenCalls).toBe(1);
    expect(state.revoked).toBe(false);
    expect(await store.get('asm.test')).toMatchObject({ accessToken: 'asm_at_1', refreshToken: 'asm_rt_1' });
  });

  it('refreshes proactively when the access token expires within 60 s', async () => {
    const { state, fetch } = fakeServer({ access: 'asm_at_old', refresh: 'asm_rt_0' });
    const store = new MemoryStore();
    await store.set('asm.test', stored({ expiresAt: Date.now() + 30_000 }));
    const r = await runCli(['search', '--project', 'p'], { deps: { fetch, storeFor: () => store } });
    expect(r.code).toBe(0);
    expect(state.tokenCalls).toBe(1);
    expect((await store.get('asm.test'))!.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('a store failure after a successful refresh → exit 1 asm: token_store_failed', async () => {
    const { fetch } = fakeServer({ access: 'asm_at_server_only', refresh: 'asm_rt_0' });
    const store = new MemoryStore();
    await store.set('asm.test', stored());
    store.set = async () => {
      throw new Error('keychain locked');
    };
    const r = await runCli(['search', '--project', 'p'], { deps: { fetch, storeFor: () => store } });
    expect(r.code).toBe(1);
    expect(r.err).toBe('asm: token_store_failed\n');
  });
});
