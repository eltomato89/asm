import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiError, api, reauth } from './api';
import { mockFetch } from '../test/utils';

afterEach(() => reauth.setHandler(null));

describe('api client', () => {
  it('sends same-origin requests with credentials', async () => {
    const { fn } = mockFetch(({ path }) => (path === '/api/setup/status' ? { body: { needsSetup: false } } : undefined));
    await expect(api.setupStatus()).resolves.toEqual({ needsSetup: false });
    const [url, init] = fn.mock.calls[0]!;
    expect(new URL(String(url)).origin).toBe(window.location.origin);
    expect(init?.credentials).toBe('include');
  });

  it('throws ApiError with the server error code', async () => {
    mockFetch(() => ({ status: 401, body: { error: 'invalid_credentials' } }));
    await expect(api.login({ username: 'a', password: 'b' })).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('on 401 reauth_required asks for re-authentication and retries once', async () => {
    let n = 0;
    const { calls } = mockFetch(({ method, path }) => {
      if (method === 'PUT' && path === '/api/automode') {
        n += 1;
        return n === 1 ? { status: 401, body: { error: 'reauth_required' } } : { body: { active: true, enabledUntil: 1, defaultDurationMin: 30, vaultIds: null } };
      }
      return undefined;
    });
    const handler = vi.fn(async () => true);
    reauth.setHandler(handler);
    await expect(api.enableAutoMode({ minutes: 30, vaultIds: null })).resolves.toMatchObject({ active: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ minutes: 30, vaultIds: null });
  });

  it('fails with reauth_required when the user cancels', async () => {
    const { calls } = mockFetch(() => ({ status: 401, body: { error: 'reauth_required' } }));
    reauth.setHandler(async () => false);
    const err = await api.enableAutoMode({ minutes: 30, vaultIds: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('reauth_required');
    expect(calls).toHaveLength(1);
  });

  it('shares one re-authentication between concurrent requests', async () => {
    const authed = { v: false };
    mockFetch(() => (authed.v ? { body: { ok: true } } : { status: 401, body: { error: 'reauth_required' } }));
    let resolve!: (v: boolean) => void;
    const handler = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    reauth.setHandler(handler);
    const a = api.disableAutoMode();
    const b = api.enableAutoMode({ minutes: 15, vaultIds: null });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    authed.v = true;
    resolve(true);
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not trigger re-authentication for plain 401 unauthenticated', async () => {
    mockFetch(() => ({ status: 401, body: { error: 'unauthenticated' } }));
    const handler = vi.fn(async () => true);
    reauth.setHandler(handler);
    await expect(api.me()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(handler).not.toHaveBeenCalled();
  });
});
