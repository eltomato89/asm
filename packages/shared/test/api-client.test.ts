import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api-client.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { status: 500, body: { error: 'internal' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('createApiClient', () => {
  it('sends JSON with the bearer token and parses the response', async () => {
    const f = fakeFetch([{ status: 201, body: { id: 'req_1', status: 'pending' } }]);
    const api = createApiClient({ baseUrl: 'https://asm.test/', getAccessToken: () => 'tok', fetch: f.fn });
    const out = await api.createRequest({ secretId: 'sec_1', project: 'p', reason: 'r' });
    expect(out).toEqual({ id: 'req_1', status: 'pending' });
    expect(f.calls[0]!.url).toBe('https://asm.test/api/cli/requests');
    const headers = new Headers(f.calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ secretId: 'sec_1', project: 'p', reason: 'r' });
  });

  it('refreshes once on 401 via onUnauthorized and retries with the new token', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'invalid_token' } }, { status: 200, body: { items: [] } }]);
    let token = 'old';
    const onUnauthorized = vi.fn(async () => {
      token = 'new';
      return true;
    });
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => token, onUnauthorized, fetch: f.fn });
    expect(await api.searchSecrets({ q: 'x', project: 'p' })).toEqual({ items: [] });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(new Headers(f.calls[1]!.init.headers).get('authorization')).toBe('Bearer new');
    expect(f.calls[1]!.url).toBe('https://asm.test/api/cli/secrets?q=x&project=p');
  });

  it('a second 401 (or a failed refresh) throws ApiError(401)', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'invalid_token' } }, { status: 401, body: { error: 'invalid_token' } }]);
    const onUnauthorized = vi.fn(async () => true);
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => 't', onUnauthorized, fetch: f.fn });
    await expect(api.archiveSecret('sec_1', { reason: 'r', project: 'p' })).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('errors are ApiError(status, code, details) and never include values from the body', async () => {
    const f = fakeFetch([{ status: 409, body: { error: 'secret_archived', value: 'LEAKED_VALUE', cause: 'archived' } }]);
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => 't', fetch: f.fn });
    const err = await api.redeemGrant('grt_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'secret_archived', details: { cause: 'archived' } });
    expect(JSON.stringify((err as ApiError).details)).not.toContain('LEAKED_VALUE');
    expect((err as Error).message).not.toContain('LEAKED_VALUE');
  });

  it('non-JSON error bodies map to http_<status>', async () => {
    const fn = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => 't', fetch: fn });
    await expect(api.searchSecrets({ q: '', project: 'p' })).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('unauthenticated OAuth calls send no Authorization header', async () => {
    const f = fakeFetch([{ status: 200, body: { device_code: 'd', user_code: 'U', verification_uri: 'v', expires_in: 600, interval: 5 } }]);
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => 't', fetch: f.fn });
    await api.deviceAuthorization({ client_name: 'asm-cli', hostname: 'h' });
    expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBeNull();
    expect(f.calls[0]!.url).toBe('https://asm.test/oauth/device_authorization');
  });

  it('wait passes timeoutMs and the abort signal', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'req_1', status: 'pending' } }]);
    const api = createApiClient({ baseUrl: 'https://asm.test', getAccessToken: () => 't', fetch: f.fn });
    const ac = new AbortController();
    await api.waitRequest('req_1', { timeoutMs: 100, signal: ac.signal });
    expect(f.calls[0]!.url).toBe('https://asm.test/api/cli/requests/req_1/wait?timeoutMs=100');
    expect(f.calls[0]!.init.signal).toBe(ac.signal);
  });
});
