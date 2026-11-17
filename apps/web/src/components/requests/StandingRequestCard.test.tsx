import type { StandingRequestDto } from '@asm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeRequest, makeStandingRequest } from '../../test/fixtures';
import { renderApp } from '../../test/renderApp';
import { appServer, query } from '../../test/server';
import type { FetchCall } from '../../test/utils';

const DECISION = '/api/standing-requests/srq_01/decision';

function server(opts: { pending?: StandingRequestDto[]; reauth?: boolean; decide?: (c: FetchCall) => { status?: number; body?: unknown } | undefined; requests?: unknown[] } = {}) {
  let recent = !opts.reauth;
  let open = opts.pending ?? [makeStandingRequest()];
  return appServer((c) => {
    if (c.path === '/api/standing-requests' && c.method === 'GET') return { body: { items: query(c).get('status') === 'pending' ? open : [] } };
    if (c.path === '/api/requests' && opts.requests) return { body: { items: query(c).get('status') === 'pending' ? opts.requests : [] } };
    if (c.path === DECISION && c.method === 'POST') {
      const custom = opts.decide?.(c);
      if (custom) return custom;
      const body = c.body as { decision: 'approve' | 'deny' };
      if (body.decision === 'approve' && !recent) return { status: 401, body: { error: 'reauth_required' } };
      const done = { ...open[0]!, status: body.decision === 'approve' ? 'approved' : 'denied' };
      open = [];
      return { body: done };
    }
    if (c.path === '/api/auth/reauth/password') {
      recent = true;
      return { body: { ok: true } };
    }
    return undefined;
  });
}

const card = () => screen.findByRole('article', { name: 'Standing access request from claude@mbp-office' });
const decisions = (calls: FetchCall[]) => calls.filter((c) => c.path === DECISION);

describe('StandingRequestCard', () => {
  it('shows the proposal as its own card above the queue and counts it in the sidebar', async () => {
    server({ pending: [makeStandingRequest({ attachedCli: [{ name: 'asm@ci', hostname: 'ci-runner' }] })], requests: [makeRequest()] });
    renderApp('/requests');
    const c = await card();
    expect(c).toHaveClass('req-standing');
    expect(c).toHaveTextContent('claude@mbp-office wants standing access for agent-secrets-manager.');
    expect(c).toHaveTextContent('Runs the test suite against staging several times a day');
    expect(c).toHaveTextContent('Also applies to asm on ci-runner.');
    expect(c).toHaveTextContent('Reading only.');
    expect(within(c).getByRole('progressbar', { name: 'Time remaining' })).toBeInTheDocument();
    // Proposal first, then the ordinary request.
    const access = await screen.findByRole('article', { name: 'Request GITHUB_TOKEN' });
    expect(c.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText('2 open')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    await waitFor(() => expect(within(nav).getByLabelText(/2/)).toBeInTheDocument());
  });

  it('with only a proposal open there is no "No open requests" message', async () => {
    server();
    renderApp('/requests');
    await card();
    expect(screen.queryByText('No open requests')).toBeNull();
  });

  it('Deny and Approve are equal-size buttons without keyboard shortcuts', async () => {
    const { calls } = server();
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    const deny = within(c).getByRole('button', { name: 'Deny' });
    const approve = within(c).getByRole('button', { name: 'Approve' });
    expect(deny).toHaveClass('standing-req-btn');
    expect(approve).toHaveClass('standing-req-btn');
    expect(c.querySelector('kbd')).toBeNull();
    await u.keyboard('a');
    await u.keyboard('d');
    expect(decisions(calls)).toEqual([]);
  });

  it('approves with the narrowed settings', async () => {
    const { calls } = server();
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('checkbox', { name: /OPENAI_API_KEY/ }));
    await u.selectOptions(within(c).getByLabelText('Duration'), '3');
    expect(c).toHaveTextContent('Adjusted by you: 1 secret removed, 3 days instead of 7');
    await u.click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Standing access for claude@mbp-office approved.')).toBeInTheDocument();
    expect(decisions(calls)[0]?.body).toEqual({
      decision: 'approve',
      settings: { scope: 'list', vaultIds: [], secretIds: ['sec_1'], days: 3, afterExpiry: 'renew', renewDays: 7 },
    });
    await waitFor(() => expect(screen.queryByRole('article', { name: /Standing access request/ })).toBeNull());
  });

  it('asks to confirm identity when the server wants a recent sign-in, then retries', async () => {
    const { calls } = server({ reauth: true });
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('button', { name: 'Approve' }));
    await u.type(await screen.findByLabelText('Password'), 'secret-enough!');
    await u.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Standing access for claude@mbp-office approved.')).toBeInTheDocument();
    expect(decisions(calls)).toHaveLength(2);
  });

  it('a cancelled confirmation keeps the card open', async () => {
    server({ reauth: true });
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('button', { name: 'Approve' }));
    await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await u.keyboard('{Escape}');
    expect(await screen.findByText('Confirmation cancelled. Nothing was changed.')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('denies without settings and without confirmation', async () => {
    const { calls } = server({ reauth: true });
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Standing access for claude@mbp-office denied.')).toBeInTheDocument();
    expect(decisions(calls).map((x) => x.body)).toEqual([{ decision: 'deny' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('maps server errors to a toast', async () => {
    server({ decide: () => ({ status: 409, body: { error: 'not_narrower' } }) });
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('You can only narrow the proposal before approving. Reload and try again.')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('Approve is disabled once every item is deselected', async () => {
    server();
    const u = userEvent.setup();
    renderApp('/requests');
    const c = await card();
    await u.click(within(c).getByRole('checkbox', { name: /GITHUB_TOKEN/ }));
    await u.click(within(c).getByRole('checkbox', { name: /OPENAI_API_KEY/ }));
    expect(within(c).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(c).getByRole('button', { name: 'Deny' })).toBeEnabled();
  });
});
