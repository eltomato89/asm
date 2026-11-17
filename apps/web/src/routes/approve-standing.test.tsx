import type { StandingApproveSummaryDto } from '@asm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStandingRequest, makeStandingSummary } from '../test/fixtures';
import { renderApp } from '../test/renderApp';
import { mockFetch, type FetchCall } from '../test/utils';

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} })),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const TOKEN = 'stok_abc-123';
const BASE = `/api/approve/standing/${TOKEN}`;

function summary(over: Partial<StandingApproveSummaryDto> = {}): StandingApproveSummaryDto {
  const r = makeStandingRequest();
  return {
    device: { name: r.device.name },
    attachedCli: [],
    project: r.project,
    reason: r.reason,
    proposal: r.proposal,
    items: r.items,
    limits: r.limits,
    status: 'pending',
    expiresAt: Date.now() + 120_000,
    final: null,
    adjusted: false,
    replaces: null,
    ...over,
  };
}

type Answer = { status?: number; body?: unknown } | undefined;

/** Public approve API only: every other call (session, setup) fails the test. */
function server(route: (c: FetchCall) => Answer) {
  return mockFetch((c) => (c.path.startsWith('/api/approve/standing/') ? route(c) : { status: 500, body: { error: 'unexpected_call' } }));
}
const otherCalls = (calls: FetchCall[]) => calls.filter((c) => !c.path.startsWith('/api/approve/standing/'));

async function loaded(name: string) {
  await screen.findByRole('heading', { level: 1 });
  return screen.getByRole('button', { name });
}

beforeEach(() => webauthn.startAuthentication.mockClear());

describe('standing approve page', () => {
  it('shows the proposal without app shell or session lookups', async () => {
    const { calls } = server(() => ({ body: summary({ attachedCli: [{ name: 'asm@ci', hostname: null }] }) }));
    renderApp(`/approve/standing/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('claude@mbp-office wants standing access for agent-secrets-manager.');
    expect(screen.getByText('Also applies to asm on asm@ci.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /GITHUB_TOKEN/ })).toBeChecked();
    expect(screen.getByRole('progressbar', { name: 'Time remaining' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(otherCalls(calls)).toEqual([]);
  });

  it('notes the expired standing approval it would replace', async () => {
    const replaces = makeStandingSummary({ active: false, scope: 'all', allowUpdates: true, afterExpiry: 'renew', renewDays: 3 });
    server(() => ({ body: summary({ replaces }) }));
    renderApp(`/approve/standing/${TOKEN}`);
    await screen.findByRole('heading', { level: 1 });
    expect(
      screen.getByText('Replaces your expired standing approval (All secrets, reading and changes, asks once after expiry, then extends by 3 days).'),
    ).toBeInTheDocument();
  });

  it('approves the narrowed proposal with a passkey (options → startAuthentication → decision)', async () => {
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { body: { challenge: 'ch-1', userVerification: 'required' } };
      if (c.path === `${BASE}/decision`) {
        const b = c.body as { settings: StandingApproveSummaryDto['final'] };
        return { body: summary({ status: 'approved', final: b.settings, adjusted: true }) };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/standing/${TOKEN}`);
    const approve = await loaded('Approve with passkey');
    await u.click(screen.getByRole('checkbox', { name: /OPENAI_API_KEY/ }));
    await u.selectOptions(screen.getByLabelText('Duration'), '3');
    await u.click(approve);
    expect(await screen.findByRole('heading', { level: 1, name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByText(/has standing access for 3 days\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open ASM' })).toHaveAttribute('href', '/');
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: 'ch-1' }) });
    expect(calls.find((c) => c.path === `${BASE}/decision`)?.body).toEqual({
      decision: 'approve',
      response: expect.objectContaining({ id: 'cred-1' }),
      settings: { scope: 'list', vaultIds: [], secretIds: ['sec_1'], days: 3, afterExpiry: 'renew', renewDays: 7 },
    });
  });

  it('denies without a passkey', async () => {
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/decision`) return { body: summary({ status: 'denied' }) };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/standing/${TOKEN}`);
    await u.click(await loaded('Deny'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Denied' })).toBeInTheDocument();
    expect(screen.getByText(/gets no standing access\./)).toBeInTheDocument();
    expect(calls.find((c) => c.path === `${BASE}/decision`)?.body).toEqual({ decision: 'deny' });
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it.each([404, 410])('shows the neutral gone state for %i', async (status) => {
    server(() => ({ status, body: { error: 'not_found' } }));
    renderApp(`/approve/standing/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'This request is no longer valid.' })).toBeInTheDocument();
  });

  it('an already decided proposal shows its outcome', async () => {
    server(() => ({ body: summary({ status: 'approved', final: { ...summary().proposal, days: 5 } }) }));
    renderApp(`/approve/standing/${TOKEN}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByText(/has standing access for 5 days\./)).toBeInTheDocument();
  });

  it('a cancelled passkey prompt sends no decision', async () => {
    webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const { calls } = server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/options`) return { body: { challenge: 'ch-1' } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/standing/${TOKEN}`);
    await u.click(await loaded('Approve with passkey'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText('Confirmation cancelled. Nothing was approved.')).toBeInTheDocument());
    expect(calls.some((c) => c.path === `${BASE}/decision`)).toBe(false);
  });

  it.each([
    ['not_narrower', 409, 'You can only narrow the proposal before approving. Reload and try again.', false],
    ['already_decided', 409, 'Already decided', true],
  ] as const)('maps %s to a toast', async (code, status, text, final) => {
    server((c) => {
      if (c.path === BASE) return { body: summary() };
      if (c.path === `${BASE}/decision`) return { status, body: { error: code } };
      return undefined;
    });
    const u = userEvent.setup();
    renderApp(`/approve/standing/${TOKEN}`);
    await u.click(await loaded('Deny'));
    const toasts = document.querySelector('.toasts') as HTMLElement;
    await waitFor(() => expect(within(toasts).getByText(text)).toBeInTheDocument());
    if (final) expect(screen.getByRole('heading', { level: 1, name: 'This request is no longer valid.' })).toBeInTheDocument();
    else expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });
});
