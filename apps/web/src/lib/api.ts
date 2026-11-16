// Typed same-origin API access for the web UI: the shared client over cookie auth,
// with global handling of `401 reauth_required` (ReauthDialog, then one retry).
// Runtime import from the api-client entry only: the package index would pull zod schemas into the bundle.
import { ApiError, createApiClient } from '@asm/shared/api-client';
import type { AccessRequestDto, AutoModeDto, ProjectDetail, ProjectDto, SecretHistory, SecretMeta, VaultDto } from '@asm/shared';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

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
const patch = <T>(path: string, body: unknown) => client.request<T>('PATCH', path, { body });
const del = <T>(path: string, body?: unknown) => client.request<T>('DELETE', path, body === undefined ? {} : { body });
const id = (s: string) => encodeURIComponent(s);

export type AutoModeInput = { minutes: number; vaultIds: string[] | null };
export type SecretStatus = 'active' | 'archived' | 'all';
export type GenerateInput = { length: number; alphabet?: 'alnum' | 'hex' | 'base64url' | 'symbols' };
export type SecretWrite = {
  title?: string;
  description?: string;
  tags?: string[];
  envName?: string | null;
  allowPlaintextToAgent?: boolean;
  value?: string;
  generate?: GenerateInput;
};
export type DeviceDto = {
  id: string;
  name: string;
  kind: 'mcp' | 'cli';
  hostname: string | null;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  lastUsedAt: number | null;
  createdAt: number;
};
export type AuditRow = {
  seq: number;
  id: string;
  ts: number;
  actorType: 'user' | 'device' | 'system';
  actorId: string | null;
  event: string;
  secretId: string | null;
  vaultId: string | null;
  deviceId: string | null;
  project: string | null;
  reason: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
};
export type AuditFilter = {
  deviceId?: string;
  secretId?: string;
  project?: string;
  event?: string;
  from?: number;
  to?: number;
  cursor?: string;
  limit?: number;
};
export type AuditPage = { items: AuditRow[]; nextCursor?: string };
export type ChainStatus = { ok: true } | { ok: false; brokenAtSeq: number };
export type Passkey = { id: string; name: string; createdAt: number; transports: string[] | null };
export type ConsentInfo = { clientName: string; redirectHost: string; requestedAt: number };
export type ActivationInfo = { name: string; hostname: string | null; requestedAt: number };

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
  decide: (requestId: string, decision: 'approve' | 'deny') => post<AccessRequestDto>(`/api/requests/${id(requestId)}/decision`, { decision }),

  secrets: (status: SecretStatus, q = '', vault?: string) => get<{ items: SecretMeta[] }>('/api/secrets', { q, status, vault }),
  secret: (secretId: string) => get<SecretMeta>(`/api/secrets/${id(secretId)}`),
  createSecret: (body: SecretWrite & { title: string; vaultId?: string }) => post<SecretMeta>('/api/secrets', body),
  updateSecret: (secretId: string, body: SecretWrite) => patch<SecretMeta>(`/api/secrets/${id(secretId)}`, body),
  deleteSecret: (secretId: string) => del<{ ok: true }>(`/api/secrets/${id(secretId)}`),
  revealSecret: (secretId: string) => post<{ value: string }>(`/api/secrets/${id(secretId)}/reveal`),
  secretHistory: (secretId: string) => get<SecretHistory>(`/api/secrets/${id(secretId)}/versions`),
  revealVersion: (secretId: string, v: number) => post<{ value: string }>(`/api/secrets/${id(secretId)}/versions/${v}/reveal`),
  restoreVersion: (secretId: string, v: number) => post<SecretMeta>(`/api/secrets/${id(secretId)}/versions/${v}/restore`),
  archiveSecret: (secretId: string, body: { reason: string; project?: string }) => post<SecretMeta>(`/api/secrets/${id(secretId)}/archive`, body),
  unarchiveSecret: (secretId: string) => post<SecretMeta>(`/api/secrets/${id(secretId)}/unarchive`),
  secretProjects: (secretId: string) => get<{ items: { project: ProjectDto; lastUsedAt: number }[] }>(`/api/secrets/${id(secretId)}/projects`),

  projects: () => get<{ items: ProjectDto[] }>('/api/projects'),
  project: (projectId: string) => get<ProjectDetail>(`/api/projects/${id(projectId)}`),
  mergeProject: (projectId: string, into: string) => post<ProjectDto>(`/api/projects/${id(projectId)}/merge`, { into }),

  createVault: (name: string) => post<VaultDto>('/api/vaults', { name }),
  addVaultMember: (vaultId: string, body: { username: string; role: 'owner' | 'member' }) => post<VaultDto>(`/api/vaults/${id(vaultId)}/members`, body),
  /** Resolves to undefined when the caller removed themself (204 without body). */
  removeVaultMember: async (vaultId: string, userId: string): Promise<VaultDto | undefined> => {
    try {
      return await del<VaultDto>(`/api/vaults/${id(vaultId)}/members`, { userId });
    } catch (e) {
      if (e instanceof SyntaxError) return undefined;
      throw e;
    }
  },

  devices: () => get<{ items: DeviceDto[] }>('/api/devices'),
  renameDevice: (deviceId: string, name: string) => patch<DeviceDto>(`/api/devices/${id(deviceId)}`, { name }),
  revokeDevice: (deviceId: string) => post<DeviceDto>(`/api/devices/${id(deviceId)}/revoke`),

  audit: (filter: AuditFilter) => get<AuditPage>('/api/audit', filter),
  verifyAudit: () => get<ChainStatus>('/api/audit/verify'),

  passkeys: () => get<Passkey[]>('/api/auth/passkeys'),
  passkeyRegisterOptions: () => post<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkey/register/options'),
  passkeyRegisterVerify: (response: RegistrationResponseJSON, name?: string) => post<Passkey>('/api/auth/passkey/register/verify', { response, ...(name ? { name } : {}) }),
  deletePasskey: (passkeyId: string) => del<{ ok: true }>(`/api/auth/passkeys/${id(passkeyId)}`),
  createUser: (body: { username: string; password?: string; isAdmin: boolean }) => post<Me>('/api/admin/users', body),

  consentInfo: (req: string) => get<ConsentInfo>(`/api/oauth/consent/${id(req)}`),
  consent: (body: { req: string; decision: 'approve' | 'deny'; deviceName?: string }) => post<{ redirectTo: string }>('/api/oauth/consent', body),
  activationInfo: (userCode: string) => get<ActivationInfo>('/api/devices/activate', { user_code: userCode }),
  activate: (body: { user_code: string; decision: 'approve' | 'deny' }) => post<{ deviceId: string; status: 'approved' | 'denied' }>('/api/devices/activate', body),
};

/** URL of the CSV export for the given filters (same-origin link; cookies authenticate the download). */
export function auditCsvUrl(filter: AuditFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && k !== 'cursor' && k !== 'limit') p.set(k, String(v));
  const qs = p.toString();
  return `/api/audit.csv${qs ? `?${qs}` : ''}`;
}

export const queryKeys = {
  setupStatus: ['setup-status'] as const,
  me: ['me'] as const,
  automode: ['automode'] as const,
  vaults: ['vaults'] as const,
  requestsAll: ['requests'] as const,
  requests: (status: 'pending' | 'all') => ['requests', status] as const,
  secretsAll: ['secrets'] as const,
  secrets: (status: SecretStatus, q: string, vault?: string) => ['secrets', 'list', status, q, vault ?? null] as const,
  secret: (secretId: string) => ['secrets', 'one', secretId] as const,
  secretHistory: (secretId: string) => ['secrets', 'history', secretId] as const,
  secretProjects: (secretId: string) => ['secrets', 'projects', secretId] as const,
  projectsAll: ['projects'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  devices: ['devices'] as const,
  auditAll: ['audit'] as const,
  audit: (filter: AuditFilter) => ['audit', filter] as const,
  auditVerify: ['audit-verify'] as const,
  passkeys: ['passkeys'] as const,
};

export const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
