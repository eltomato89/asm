import { ME, VAULTS } from './fixtures';
import { mockFetch, type FetchCall } from './utils';

type Answer = { status?: number; body?: unknown } | undefined;

/**
 * Fetch-level fake of a signed-in ASM server: `extra` answers first; common endpoints fall back to empty data.
 */
export function appServer(extra: (c: FetchCall) => Answer = () => undefined, opts: { me?: typeof ME } = {}) {
  return mockFetch((c) => {
    const x = extra(c);
    if (x) return x;
    if (c.path === '/api/setup/status') return { body: { needsSetup: false } };
    if (c.path === '/api/auth/me') return { body: opts.me ?? ME };
    if (c.path === '/api/automode') return { body: { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null } };
    if (c.path === '/api/vaults' && c.method === 'GET') return { body: VAULTS };
    if (c.path === '/api/requests') return { body: { items: [] } };
    if (c.path === '/api/secrets' && c.method === 'GET') return { body: { items: [] } };
    if (c.path === '/api/devices' && c.method === 'GET') return { body: { items: [] } };
    if (c.path === '/api/projects' && c.method === 'GET') return { body: { items: [] } };
    if (c.path === '/api/audit') return { body: { items: [] } };
    if (c.path === '/api/audit/verify') return { body: { ok: true } };
    if (c.path === '/api/auth/passkeys') return { body: [] };
    if (c.path === '/api/admin/users' && c.method === 'GET') return { body: { items: [] } };
    return undefined;
  });
}

export const query = (c: FetchCall) => new URLSearchParams(c.search);
