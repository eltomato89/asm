// Typed same-origin API access for the web UI: the shared client over cookie auth,
// with global handling of `401 reauth_required` (ReauthDialog, then one retry).
// Runtime import from the api-client entry only: the package index would pull zod schemas into the bundle.
import { ApiError, createApiClient } from '@asm/shared/api-client';
import type { AccessRequestDto, AutoModeDto, SecretMeta, VaultDto } from '@asm/shared';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export { ApiError };

export type Me = { id: string; username: string; isAdmin: boolean };

type ReauthHandler = () => Promise<boolean>;

/** Broker between failed requests and the mounted ReauthDialog; concurrent requests share one prompt. */
export const reauth = (() => {
  let handler: ReauthHandler | null = null;
  let pending: Promise<boolean> | null = null;
  return {
    setHandler(fn: ReauthHandler | null) {
      handler = fn;
    },
    request(): Promise<boolean> {
      if (!handler) return Promise.resolve(false);
      pending ??= handler()
        .catch(() => false)
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
})();

const REAUTH_PATHS = ['/api/auth/reauth/'];

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.clone().json();
    return body && typeof body === 'object' ? ((body as { error?: unknown }).error as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** fetch with session cookies; a `reauth_required` answer opens the ReauthDialog and retries once. */
export async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const send = () => globalThis.fetch(input, { ...init, credentials: 'include' });
  const res = await send();
  if (res.status !== 401) return res;
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
  if (REAUTH_PATHS.some((p) => path.startsWith(p))) return res;
  if ((await errorCode(res)) !== 'reauth_required') return res;
  if (!(await reauth.request())) return res;
  return send();
}

const client = createApiClient({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  getAccessToken: () => undefined,
  fetch: sessionFetch,
});

const get = <T>(path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal) =>
  client.request<T>('GET', path, { query, signal });
const post = <T>(path: string, body: unknown = {}) => client.request<T>('POST', path, { body });

export type AutoModeInput = { minutes: number; vaultIds: string[] | null };

export const api = {
  setupStatus: () => get<{ needsSetup: boolean }>('/api/setup/status'),
  setup: (body: { token: string; username: string; password: string }) => post<Me>('/api/setup', body),
  me: () => get<Me>('/api/auth/me'),
  login: (body: { username: string; password: string }) => post<Me>('/api/auth/login', body),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  passkeyLoginOptions: () => post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/login/options'),
  passkeyLoginVerify: (response: AuthenticationResponseJSON) => post<Me>('/api/auth/passkey/login/verify', { response }),
  reauthPasskeyOptions: () => post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/reauth/passkey/options'),
  reauthPasskeyVerify: (response: AuthenticationResponseJSON) => post<{ ok: true }>('/api/auth/reauth/passkey/verify', { response }),
  reauthPassword: (password: string) => post<{ ok: true }>('/api/auth/reauth/password', { password }),
  autoMode: () => get<AutoModeDto>('/api/automode'),
  enableAutoMode: (body: AutoModeInput) => client.request<AutoModeDto>('PUT', '/api/automode', { body }),
  disableAutoMode: () => client.request<AutoModeDto>('DELETE', '/api/automode'),
  vaults: () => get<{ items: VaultDto[] }>('/api/vaults'),
  requests: (status: 'pending' | 'all') => get<{ items: AccessRequestDto[] }>('/api/requests', { status }),
  searchSecrets: (q: string, signal?: AbortSignal) => get<{ items: SecretMeta[] }>('/api/secrets', { q }, signal),
};

export const queryKeys = {
  setupStatus: ['setup-status'] as const,
  me: ['me'] as const,
  automode: ['automode'] as const,
  vaults: ['vaults'] as const,
  requestsAll: ['requests'] as const,
  requests: (status: 'pending' | 'all') => ['requests', status] as const,
};

export const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
