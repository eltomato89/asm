// Typed fetch client for the ASM HTTP API (used by the CLI and the web app).
// Self-contained with type-only imports so Node can load it directly (type stripping) from the compiled CLI.
import type { AccessRequestDto, SecretMeta } from './schemas.js';

/** API failure: HTTP status, error code and code-like details. Never carries values or raw response bodies. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string>;

  constructor(status: number, code: string, details: Record<string, string> = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  getAccessToken: () => string | undefined | Promise<string | undefined>;
  /** Called once on a 401; return true after refreshing the tokens to retry the request. */
  onUnauthorized?: () => boolean | Promise<boolean>;
  fetch?: typeof fetch;
};

/** Request DTO as returned to CLI devices: approved reads carry the grant id, approved updates the new version. */
export type CliRequestDto = AccessRequestDto & { grantId?: string; version?: number | null };
export type RedeemedSecret = { secretId: string; envName: string | null; value: string };
export type GenerateInput = { length: number; alphabet?: 'alnum' | 'hex' | 'base64url' | 'symbols' };
export type CliSecretCreateInput = {
  title: string;
  description?: string;
  tags?: string[];
  envName?: string;
  vaultId?: string;
  value?: string;
  generate?: GenerateInput;
  project: string;
  reason: string;
};
export type CliSecretUpdateInput = {
  project: string;
  reason: string;
  title?: string;
  description?: string;
  tags?: string[];
  envName?: string | null;
  value?: string;
  generate?: GenerateInput;
};
export type DeviceAuthorization = { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
export type TokenResponse = { access_token: string; token_type: string; expires_in: number; refresh_token: string };

type RequestOptions = { body?: unknown; query?: Record<string, string | number | undefined>; auth?: boolean; signal?: AbortSignal };

/** Keeps only short string fields that look like codes (never `value` or long free text). */
function codeDetails(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'error' || k === 'value' || typeof v !== 'string' || v.length > 100) continue;
    out[k] = v;
  }
  return out;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    const b = body as Record<string, unknown>;
    return new ApiError(res.status, b.error as string, codeDetails(b));
  }
  return new ApiError(res.status, `http_${res.status}`);
}

export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function send(method: string, path: string, o: RequestOptions): Promise<Response> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.auth !== false) {
      const token = await opts.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return doFetch(url.toString(), {
      method,
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  }

  async function request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    let res = await send(method, path, o);
    if (res.status === 401 && o.auth !== false && opts.onUnauthorized) {
      await res.body?.cancel();
      if (await opts.onUnauthorized()) res = await send(method, path, o);
      else return Promise.reject(new ApiError(401, 'unauthenticated'));
    }
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as T;
  }

  const id = (s: string) => encodeURIComponent(s);

  return {
    request,
    // ---------- OAuth (unauthenticated) ----------
    deviceAuthorization: (body: { client_name: string; hostname?: string }) =>
      request<DeviceAuthorization>('POST', '/oauth/device_authorization', { body, auth: false }),
    token: (body: Record<string, string>) => request<TokenResponse>('POST', '/oauth/token', { body, auth: false }),
    // ---------- CLI device API ----------
    redeemGrant: (grantId: string, hostname?: string) =>
      request<{ secrets: RedeemedSecret[] }>('POST', `/api/grants/${id(grantId)}/redeem`, { body: hostname ? { hostname } : {} }),
    createRequest: (body: { secretId: string; project: string; reason: string }) => request<CliRequestDto>('POST', '/api/cli/requests', { body }),
    waitRequest: (requestId: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
      request<CliRequestDto>('GET', `/api/cli/requests/${id(requestId)}/wait`, { query: { timeoutMs: o.timeoutMs }, signal: o.signal }),
    createSecret: (body: CliSecretCreateInput) => request<{ secretId: string; version: number }>('POST', '/api/cli/secrets', { body }),
    updateSecret: (secretId: string, body: CliSecretUpdateInput) =>
      request<CliRequestDto>('POST', `/api/cli/secrets/${id(secretId)}/update`, { body }),
    archiveSecret: (secretId: string, body: { reason: string; project: string }) =>
      request<SecretMeta>('POST', `/api/cli/secrets/${id(secretId)}/archive`, { body }),
    searchSecrets: (q: { q: string; project: string; archived?: boolean; vault?: string }) =>
      request<{ items: SecretMeta[] }>('GET', '/api/cli/secrets', {
        query: { q: q.q, project: q.project, archived: q.archived ? 'true' : undefined, vault: q.vault },
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
