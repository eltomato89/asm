import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproveSummaryDto } from '../lib/push-types';
import { renderApp } from '../test/renderApp';
import { mockFetch, type FetchCall } from '../test/utils';

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} })),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const TOKEN = 'tok_abc-123';
const BASE = `/api/approve/${TOKEN}`;

const summary = (over: Partial<ApproveSummaryDto> = {}): ApproveSummaryDto => ({
  kind: 'read',
  device: { name: 'claude@mbp-office' },
  secret: { title: 'GitHub', envName: 'GITHUB_TOKEN' },
  project: 'agent-secrets-manager',
  reason: 'Release-Workflow pushen',
  delivery: 'cli',
  expiresAt: Date.now() + 120_000,
  status: 'pending',
  ...over,
});

type Answer = { status?: number; body?: unknown } | undefined;

/** Public approve API only: every other call (session, setup) is a failure of the test. */
function server(route: (c: FetchCall) => Answer) {
  return mockFetch((c) => {
    if (c.path.startsWith('/api/approve/')) return route(c);
    return { status: 500, body: { error: 'unexpected_call' } };
  });
}

/** The button once the request has loaded (the skeleton shows disabled buttons with the same names). */
async function loaded(name: string) {
  await screen.findByRole('heading', { level: 1 });
  return screen.getByRole('button', { name });
}

const otherCalls = (calls: FetchCall[]) => calls.filter((c) => !c.path.startsWith('/api/approve/'));

beforeEach(() => {
  webauthn.startAuthentication.mockClear();
});

describe('approve page', () => {
  it('shows the pending request without app shell and without session or setup lookups', async () => {
    const { calls } = server((c) => (c.path === BASE ? { body: summary() } : undefined));
    renderApp(`/approve/${TOKEN}`);
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('claude@mbp-office möchte GITHUB_TOKEN für agent-secrets-manager.');
    expect(screen.getByText('Release-Workflow pushen')).toBeInTheDocument();
    expect(screen.getByText('via CLI-Übergabe')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Verbleibende Zeit' })).toBeInTheDocument();
    expect(screen.getByText(/läuft ab in/)).toHaveTextContent(/0[12]:\d\d/);
    expect(screen.getByRole('button', { name: 'Verweigern' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mit Face ID freigeben' })).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    expect(otherCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.path === '/api/auth/me' || c.path === '/api/setup/status')).toBe(false);
  });

  it('shows a skeleton while loading', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByLabelText('Anfrage wird geladen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mit Face ID freigeben' })).toBeDisabled();
  });

  it('update requests show the metadata diff and the value change, never a value', async () => {
    server(() => ({
      body: summary({ kind: 'update', delivery: null, metaDiff: { title: { from: 'GitHub', to: 'GitHub CI' } }, valueChanged: true }),
    }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('claude@mbp-office möchte GITHUB_TOKEN ändern.');
    const title = screen.getByLabelText('Titel');
    expect(title).toHaveTextContent('GitHub');
    expect(title).toHaveTextContent('GitHub CI');
    expect(screen.getByLabelText('Wert')).toHaveTextContent('Wert wird geändert');
    expect(screen.getByText('agent-secrets-manager')).toBeInTheDocument();
  });

  it('approves with a passkey assertion (options → startAuthentication → decision)', async () => {
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options` && c.method === 'POST') return { body: { challenge: 'ch-1', userVerification: 'required', allowCredentials: [] } };
      if (c.path === `${BASE}/decision` && c.method === 'POST') return { body: summary({ status: 'approved' }) };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Mit Face ID freigeben'));
    expect(await screen.findByRole('heading', { name: 'Freigegeben' })).toBeInTheDocument();
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: 'ch-1' }) });
    const decision = calls.find((c) => c.path === `${BASE}/decision`);
    expect(decision?.body).toEqual({ decision: 'approve', response: expect.objectContaining({ id: 'cred-1' }) });
    expect(screen.queryByRole('progressbar')).toBeNull();
    // The token is consumed by the decision: the final state comes from its response, no refetch.
    expect(calls.filter((c) => c.path === BASE)).toHaveLength(1);
    expect(otherCalls(calls)).toEqual([]);
  });

  it('denies without a passkey', async () => {
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/decision`) return { body: summary({ status: 'denied' }) };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Verweigern'));
    expect(await screen.findByRole('heading', { name: 'Verweigert' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === `${BASE}/decision`)?.body).toEqual({ decision: 'deny' });
    expect(calls.some((c) => c.path === `${BASE}/options`)).toBe(false);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it.each([404, 410])('shows one neutral message for %i', async (status) => {
    server(() => ({ status, body: { error: status === 404 ? 'not_found' : 'expired' } }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Diese Anfrage ist nicht mehr gültig.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mit Face ID freigeben' })).toBeNull();
  });

  it('treats an elapsed expiry as no longer valid', async () => {
    server(() => ({ body: summary({ expiresAt: Date.now() - 1000 }) }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Diese Anfrage ist nicht mehr gültig.' })).toBeInTheDocument();
  });

  it('a failed verification shows a toast and keeps the request open', async () => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { body: { challenge: 'ch-1' } };
      if (c.path === `${BASE}/decision`) return { status: 401, body: { error: 'verification_failed' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Mit Face ID freigeben'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText('Bestätigung fehlgeschlagen')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Mit Face ID freigeben' })).toBeEnabled();
  });

  it.each([
    ['plaintext_not_allowed', 403, {}, 'Klartext für dieses Secret nicht erlaubt', false],
    ['apply_failed', 409, { cause: 'stale' }, 'Änderung konnte nicht übernommen werden (Secret wurde inzwischen geändert)', false],
    ['already_decided', 409, {}, 'Bereits entschieden', true],
    ['device_inactive', 409, {}, 'Das Gerät ist nicht mehr aktiv. Die Anfrage wurde verweigert.', true],
    ['bad_origin', 403, {}, 'Diese Seite wurde über eine unerwartete Adresse geöffnet. Öffne den Link aus der Benachrichtigung erneut.', false],
  ] as const)('maps %s to a toast', async (code, status, extra, text, final) => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/decision`) return { status, body: { error: code, ...extra } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Verweigern'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText(text)).toBeInTheDocument());
    if (final) expect(screen.getByRole('heading', { name: 'Diese Anfrage ist nicht mehr gültig.' })).toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Verweigern' })).toBeEnabled();
  });

  it('no_passkey on options explains how to add one and skips the prompt', async () => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { status: 409, body: { error: 'no_passkey' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Mit Face ID freigeben'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText(/kein Passkey hinterlegt/)).toBeInTheDocument());
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it('a cancelled Face ID prompt sends no decision', async () => {
    webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { body: { challenge: 'ch-1' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Mit Face ID freigeben'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText('Bestätigung abgebrochen. Nichts wurde freigegeben.')).toBeInTheDocument());
    expect(calls.some((c) => c.path === `${BASE}/decision`)).toBe(false);
  });
});
