import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { ApproveSummaryDto } from '@asm/shared';
import { approveErrorText } from './approve';
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
  reason: 'Push the release workflow',
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
    expect(h1).toHaveTextContent('claude@mbp-office wants GITHUB_TOKEN for agent-secrets-manager.');
    expect(screen.getByText('Push the release workflow')).toBeInTheDocument();
    expect(screen.getByText('via CLI handoff')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Time remaining' })).toBeInTheDocument();
    expect(screen.getByText(/expires in/)).toHaveTextContent(/0[12]:\d\d/);
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(otherCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.path === '/api/auth/me' || c.path === '/api/setup/status')).toBe(false);
  });

  it('shows a skeleton while loading', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByLabelText('Loading request')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve with passkey' })).toBeDisabled();
  });

  it('update requests show the metadata diff and the value change, never a value', async () => {
    server(() => ({
      body: summary({ kind: 'update', delivery: null, metaDiff: { title: { from: 'GitHub', to: 'GitHub CI' } }, valueChanged: true }),
    }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('claude@mbp-office wants to change GITHUB_TOKEN.');
    const title = screen.getByLabelText('Title');
    expect(title).toHaveTextContent('GitHub');
    expect(title).toHaveTextContent('GitHub CI');
    expect(screen.getByLabelText('Value')).toHaveTextContent('Value will change');
    expect(screen.getByText('agent-secrets-manager')).toBeInTheDocument();
  });

  it('renders redacted diff fields without values', async () => {
    server(() => ({
      body: summary({
        kind: 'update',
        delivery: null,
        metaDiff: { title: { from: 'GitHub', to: 'GitHub CI' }, description: { from: null, to: null, redacted: true }, tags: { from: null, to: null, redacted: true } },
      }),
    }));
    renderApp(`/approve/${TOKEN}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByLabelText('Description')).toHaveTextContent('Description will change');
    expect(screen.getByLabelText('Tags')).toHaveTextContent('Tags will change');
    expect(screen.getByLabelText('Description')).not.toHaveTextContent('→');
    expect(screen.getByLabelText('Title')).toHaveTextContent('GitHub CI');
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
    await u.click(await loaded('Approve with passkey'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Approved' })).toBeInTheDocument();
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
    await u.click(await loaded('Deny'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Denied' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === `${BASE}/decision`)?.body).toEqual({ decision: 'deny' });
    expect(calls.some((c) => c.path === `${BASE}/options`)).toBe(false);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it.each([404, 410])('shows one neutral message for %i', async (status) => {
    server(() => ({ status, body: { error: status === 404 ? 'not_found' : 'expired' } }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'This request is no longer valid.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve with passkey' })).toBeNull();
  });

  it('treats an elapsed expiry as no longer valid', async () => {
    server(() => ({ body: summary({ expiresAt: Date.now() - 1000 }) }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'This request is no longer valid.' })).toBeInTheDocument();
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
    await u.click(await loaded('Approve with passkey'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText('Verification failed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled();
  });

  it.each([
    ['plaintext_not_allowed', 403, {}, 'Plaintext is not allowed for this secret', false],
    ['apply_failed', 409, { cause: 'stale' }, 'Change could not be applied (secret was changed in the meantime)', false],
    ['already_decided', 409, {}, 'Already decided', true],
    ['device_inactive', 409, {}, 'The device is no longer active. The request was denied.', true],
    ['bad_origin', 403, {}, 'This page was opened from an unexpected address. Open the link from the notification again.', false],
  ] as const)('maps %s to a toast', async (code, status, extra, text, final) => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/decision`) return { status, body: { error: code, ...extra } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Deny'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText(text)).toBeInTheDocument());
    if (final) expect(screen.getByRole('heading', { level: 1, name: 'This request is no longer valid.' })).toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('no_passkey on options explains how to add one and skips the prompt', async () => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { status: 409, body: { error: 'no_passkey' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/${TOKEN}`);
    await u.click(await loaded('Approve with passkey'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText(/no passkey on your account/)).toBeInTheDocument());
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
    await u.click(await loaded('Approve with passkey'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText('Confirmation cancelled. Nothing was approved.')).toBeInTheDocument());
    expect(calls.some((c) => c.path === `${BASE}/decision`)).toBe(false);
  });

  it('shows the title as a secondary line next to the ENV name', async () => {
    server(() => ({ body: summary() }));
    renderApp(`/approve/${TOKEN}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('GitHub')).toHaveClass('approve-title');
  });

  it('uses the title in the sentence when there is no ENV name', async () => {
    server(() => ({ body: summary({ secret: { title: 'GitHub', envName: null } }) }));
    renderApp(`/approve/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('wants GitHub for');
    expect(document.querySelector('.approve-title')).toBeNull();
  });

  it('labels the approve button with Face ID on iPhone', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    server(() => ({ body: summary() }));
    renderApp(`/approve/${TOKEN}`);
    expect(await loaded('Approve with Face ID')).toBeEnabled();
    vi.restoreAllMocks();
  });
});

describe('approveErrorText', () => {
  it.each([
    ['forbidden', 403, "You don't have permission to do that."],
    ['invalid_request', 400, 'Invalid request. Reload the page and try again.'],
    ['rate_limited', 429, 'Too many attempts. Wait a minute and try again.'],
    ['no_passkey', 409, "There's no passkey on your account. Add one under Settings on your home network."],
    ['something_new', 500, 'Decision failed. Check the connection and try again.'],
  ])('%s', (code, status, text) => {
    expect(approveErrorText(new ApiError(status, code, {}))).toBe(text);
  });
});
