import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
    if (c.path === '/api/vaults') return { body: { items: [{ id: 'vlt_p', name: 'Persönlich', personal: true, role: 'owner', members: [], createdAt: 0 }] } };
    if (c.path === '/api/requests') return { body: { items: [] } };
    if (c.path === '/api/secrets') return { body: { items: [] } };
    return undefined;
  });
}

describe('route guard', () => {
  it('redirects to /setup when the server needs setup', async () => {
    server({ needsSetup: true });
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'ASM einrichten' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/setup');
    expect(screen.getByLabelText('Einrichtungs-Token')).toBeInTheDocument();
  });

  it('redirects /login to /setup while setup is pending', async () => {
    server({ needsSetup: true });
    const { router } = renderApp('/login');
    await screen.findByRole('heading', { name: 'ASM einrichten' });
    expect(router.state.location.pathname).toBe('/setup');
  });

  it('redirects to /login when not authenticated', async () => {
    server({});
    const { router } = renderApp('/secrets');
    expect(await screen.findByRole('heading', { name: 'Anmelden' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('renders the app shell with sidebar navigation when authenticated', async () => {
    server({ loggedIn: true });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    for (const label of ['Übersicht', 'Anfragen', 'Secrets', 'Projekte', 'Tresore', 'Geräte', 'Audit-Log', 'Einstellungen']) {
      expect(nav).toHaveTextContent(label);
    }
    await waitFor(() => expect(screen.getByRole('button', { name: /Tresor wechseln/ })).toHaveTextContent('Persönlich'));
  });

  it('renders an empty-state placeholder for pages of later tasks', async () => {
    server({ loggedIn: true });
    renderApp('/audit');
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit-Log' })).toBeInTheDocument();
    expect(screen.getByText(/noch nicht verfügbar/)).toBeInTheDocument();
  });
});

describe('login page', () => {
  it('shows „Mit Passkey anmelden“ and the password form', async () => {
    server({});
    renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Mit Passkey anmelden' })).toBeInTheDocument();
    expect(screen.getByLabelText('Benutzername')).toBeInTheDocument();
    expect(screen.getByLabelText('Passwort')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Anmelden' })).toBeInTheDocument();
  });

  it('signs in with username and password and opens the app', async () => {
    const state = { loggedIn: false };
    const { calls } = server(state, (c) => {
      if (c.path === '/api/auth/login') {
        const b = c.body as { password: string };
        if (b.password !== 'richtig-langes-pw') return { status: 401, body: { error: 'invalid_credentials' } };
        state.loggedIn = true;
        return { body: ME };
      }
      return undefined;
    });
    const user = userEvent.setup();
    const { router } = renderApp('/login');
    await user.type(await screen.findByLabelText('Benutzername'), 'jana');
    await user.type(screen.getByLabelText('Passwort'), 'falsch');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByText('Benutzername oder Passwort ist falsch.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Passwort'));
    await user.type(screen.getByLabelText('Passwort'), 'richtig-langes-pw');
    await user.click(screen.getByRole('button', { name: 'Anmelden' }));
    await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(router.state.location.pathname).toBe('/');
    expect(calls.filter((c) => c.path === '/api/auth/login').at(-1)?.body).toEqual({ username: 'jana', password: 'richtig-langes-pw' });
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
    await user.type(await screen.findByLabelText('Einrichtungs-Token'), 'tok-123');
    await user.type(screen.getByLabelText('Benutzername'), 'jana');
    await user.type(screen.getByLabelText('Passwort'), 'ein-sehr-langes-passwort');
    await user.click(screen.getByRole('button', { name: 'Konto anlegen' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.find((c) => c.path === '/api/setup')?.body).toEqual({ token: 'tok-123', username: 'jana', password: 'ein-sehr-langes-passwort' });
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
                id: 'sec_01', vaultId: 'vlt_p', vaultName: 'Persönlich', title: 'GitHub', description: '', tags: [],
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
    await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('github');
    await user.click(await screen.findByRole('option', { name: /GITHUB_TOKEN/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/secrets'));
    expect(router.state.location.search).toEqual({ selected: 'sec_01' });
  });
});
