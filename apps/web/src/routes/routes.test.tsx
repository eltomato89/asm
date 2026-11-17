import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeRequest } from '../test/fixtures';
import { safeRedirect } from './router';
import { renderApp } from '../test/renderApp';
import { mockFetch, type FetchCall } from '../test/utils';

const ME = { id: 'usr_1', username: 'jana', isAdmin: true };
const inactive = { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null };

/** Fake server: `needsSetup`, `loggedIn` drive the guard; common authenticated endpoints answer empty. */
function server(state: { needsSetup?: boolean; loggedIn?: boolean }, extra?: (c: FetchCall) => { status?: number; body?: unknown } | undefined) {
  return mockFetch((c) => {
    const x = extra?.(c);
    if (x) return x;
    if (c.path === '/api/setup/status') return { body: { needsSetup: !!state.needsSetup } };
    if (c.path === '/api/auth/me') return state.loggedIn ? { body: ME } : { status: 401, body: { error: 'unauthenticated' } };
    if (!state.loggedIn) return { status: 401, body: { error: 'unauthenticated' } };
    if (c.path === '/api/automode') return { body: inactive };
    if (c.path === '/api/vaults') return { body: { items: [{ id: 'vlt_p', name: 'Personal', personal: true, role: 'owner', members: [], createdAt: 0 }] } };
    if (c.path === '/api/requests') return { body: { items: [] } };
    if (c.path === '/api/secrets') return { body: { items: [] } };
    return undefined;
  });
}

describe('route guard', () => {
  it('redirects to /setup when the server needs setup', async () => {
    server({ needsSetup: true });
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Set up ASM' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/setup');
    expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
  });

  it('redirects /login to /setup while setup is pending', async () => {
    server({ needsSetup: true });
    const { router } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Set up ASM' });
    expect(router.state.location.pathname).toBe('/setup');
  });

  it('redirects to /login when not authenticated', async () => {
    server({});
    const { router } = renderApp('/secrets');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('renders the app shell with sidebar navigation when authenticated', async () => {
    server({ loggedIn: true });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    for (const label of ['Overview', 'Requests', 'Secrets', 'Projects', 'Vaults', 'Devices', 'Audit log', 'Settings']) {
      expect(nav).toHaveTextContent(label);
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch vault/ })).toHaveTextContent('Personal'));
  });

  it('renders every page of the app shell', async () => {
    server({ loggedIn: true });
    for (const [path, heading] of [
      ['/', 'Requests'],
      ['/requests', 'Requests'],
      ['/secrets', 'Secrets'],
      ['/projects', 'Projects'],
      ['/vaults', 'Vaults'],
      ['/devices', 'Devices'],
      ['/audit', 'Audit log'],
      ['/settings', 'Settings'],
    ] as const) {
      const { unmount } = renderApp(path);
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      expect(screen.queryByText(/not available yet/)).toBeNull();
      unmount();
    }
  });

  it('a mutation failing with 401 unauthenticated redirects to /login and keeps the page as target', async () => {
    const state = { loggedIn: true };
    server(state, (c) => {
      if (c.path === '/api/requests' && state.loggedIn) {
        return { body: { items: [makeRequest()] } };
      }
      if (c.path.endsWith('/decision')) {
        state.loggedIn = false;
        return { status: 401, body: { error: 'unauthenticated' } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/requests');
    await user.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ redirect: '/requests' });
  });

  it('shows the error state with “Reload” when a page fails to render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server({ loggedIn: true }, (c) => (c.path === '/api/secrets/sec_x' ? { body: { id: 'sec_x' } } : undefined));
    renderApp('/secrets?selected=sec_x');
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe('login redirect target', () => {
  it('sends /connect?req=… through the login and back', async () => {
    const state = { loggedIn: false };
    server(state, (c) => {
      if (c.path === '/api/auth/login') {
        state.loggedIn = true;
        return { body: ME };
      }
      if (c.path === '/api/oauth/consent/abc') return { body: { clientName: 'Claude Code', redirectHost: '127.0.0.1:5000', requestedAt: 0 } };
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/connect?req=abc');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.search).toEqual({ redirect: '/connect?req=abc' });
    await user.type(screen.getByLabelText('Username'), 'jana');
    await user.type(screen.getByLabelText('Password'), 'right-long-pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Claude Code wants to connect to ASM' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/connect');
    expect(router.state.location.search).toEqual({ req: 'abc' });
  });

  it('keeps /activate as target and ignores foreign redirect targets', async () => {
    server({});
    const { router } = renderApp('/activate');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(router.state.location.search).toEqual({ redirect: '/activate' });
    expect(safeRedirect('//evil.example/x')).toBeUndefined();
    expect(safeRedirect('https://evil.example')).toBeUndefined();
    expect(safeRedirect('/\\evil')).toBeUndefined();
    expect(safeRedirect('/\nevil')).toBeUndefined();
    expect(safeRedirect('/\tx')).toBeUndefined();
    expect(safeRedirect('/a\\b')).toBeUndefined();
    expect(safeRedirect('javascript:alert(1)')).toBeUndefined();
    expect(safeRedirect('/connect?req=1')).toBe('/connect?req=1');
    // Paths that normalize to a protocol-relative "//host" would become an off-site navigation.
    for (const t of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/%2E%2E//evil.com', '/a/..//evil.com', '/.///evil.com']) {
      expect(safeRedirect(t), t).toBeUndefined();
    }
    expect(safeRedirect('/secrets/../activate')).toBe('/activate');
  });
});

describe('login page', () => {
  it('shows “Sign in with passkey” and the password form', async () => {
    server({});
    renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Sign in with passkey' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs in with username and password and opens the app', async () => {
    const state = { loggedIn: false };
    const { calls } = server(state, (c) => {
      if (c.path === '/api/auth/login') {
        const b = c.body as { password: string };
        if (b.password !== 'right-long-pw') return { status: 401, body: { error: 'invalid_credentials' } };
        state.loggedIn = true;
        return { body: ME };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/login');
    await user.type(await screen.findByLabelText('Username'), 'jana');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'right-long-pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(router.state.location.pathname).toBe('/');
    expect(calls.filter((c) => c.path === '/api/auth/login').at(-1)?.body).toEqual({ username: 'jana', password: 'right-long-pw' });
  });
});

describe('setup page', () => {
  it('creates the first admin with the token and continues to login', async () => {
    const state = { needsSetup: true };
    const { calls } = server(state, (c) => {
      if (c.path === '/api/setup' && c.method === 'POST') {
        state.needsSetup = false;
        return { status: 201, body: { id: 'usr_1', username: 'jana', isAdmin: true } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/setup');
    await user.type(await screen.findByLabelText('Setup token'), 'tok-123');
    await user.type(screen.getByLabelText('Username'), 'jana');
    await user.type(screen.getByLabelText('Password'), 'a-very-long-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.find((c) => c.path === '/api/setup')?.body).toEqual({ token: 'tok-123', username: 'jana', password: 'a-very-long-password' });
  });
});

describe('command palette in the app', () => {
  it('finds a secret and navigates to /secrets?selected=<id>', async () => {
    server({ loggedIn: true }, (c) => {
      if (c.path === '/api/secrets' && new URLSearchParams(c.search).get('q')) {
        return {
          body: {
            items: [
              {
                id: 'sec_01', vaultId: 'vlt_p', vaultName: 'Personal', title: 'GitHub', description: '', tags: [],
                envName: 'GITHUB_TOKEN', allowPlaintextToAgent: false, updatedAt: 0, archived: null,
              },
            ],
          },
        };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('github');
    await user.click(await screen.findByRole('option', { name: /GITHUB_TOKEN/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/secrets'));
    expect(router.state.location.search).toEqual({ selected: 'sec_01' });
  });
});
