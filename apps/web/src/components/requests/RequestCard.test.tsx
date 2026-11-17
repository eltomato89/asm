import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeRequest, T0 } from '../../test/fixtures';
import { mockFetch, renderWithProviders } from '../../test/utils';
import { RequestCard } from './RequestCard';
import { RequestQueue } from './RequestQueue';

describe('RequestCard', () => {
  it('renders the sentence, italic reason and delivery hint', () => {
    renderWithProviders(<RequestCard request={makeRequest()} now={T0} onDecide={vi.fn()} />);
    const card = screen.getByRole('article');
    expect(card).toHaveTextContent('claude@mbp-office wants GITHUB_TOKEN for agent-secrets-manager.');
    expect(within(card).getByText('Release-Workflow pushen').tagName).toBe('P');
    expect(within(card).getByText('Release-Workflow pushen')).toHaveClass('req-reason');
    expect(card).toHaveTextContent('via CLI handoff');
  });

  it('shows "Plaintext to agent" for plaintext delivery and the title when there is no ENV name', () => {
    renderWithProviders(
      <RequestCard request={makeRequest({ delivery: 'plaintext', secret: { id: 's', title: 'Stripe Key', envName: null, vaultId: 'v', vaultName: 'P' } })} now={T0} onDecide={vi.fn()} />,
    );
    expect(screen.getByRole('article')).toHaveTextContent('wants Stripe Key for');
    expect(screen.getByRole('article')).toHaveTextContent('Plaintext to agent');
  });

  it('time bar width is proportional to the remaining time', () => {
    const { rerender } = renderWithProviders(<RequestCard request={makeRequest()} now={T0 + 60_000} onDecide={vi.fn()} />);
    const bar = () => screen.getByRole('progressbar', { name: 'Time remaining' });
    expect(bar().firstElementChild).toHaveStyle({ width: '80%' });
    expect(bar()).toHaveAttribute('aria-valuenow', '240');
    expect(screen.getByRole('article')).toHaveTextContent('expires in 4:00');
    rerender(<RequestCard request={makeRequest()} now={T0 + 225_000} onDecide={vi.fn()} />);
    expect(bar().firstElementChild).toHaveStyle({ width: '25%' });
  });

  it('update card shows the metadata diff "Title: old → new" and "Value will change"', () => {
    renderWithProviders(
      <RequestCard
        request={makeRequest({ kind: 'update', delivery: null, metaDiff: { title: { from: 'Stripe alt', to: 'Stripe neu' } }, valueChanged: true })}
        now={T0}
        onDecide={vi.fn()}
      />,
    );
    const card = screen.getByRole('article');
    expect(card).toHaveTextContent('claude@mbp-office wants to change GITHUB_TOKEN.');
    const diff = within(card).getByRole('definition', { name: 'Title' });
    expect(diff).toHaveTextContent('Stripe alt→Stripe neu');
    expect(within(card).getByText('Title')).toBeInTheDocument();
    expect(card).toHaveTextContent('Value will change');
  });
});

describe('RequestQueue', () => {
  it('approves the focused card with the A key', async () => {
    const pending = [makeRequest(), makeRequest({ id: 'req_02', secret: { id: 's2', title: 'x', envName: 'OPENAI_API_KEY', vaultId: 'v', vaultName: 'P' } })];
    const { calls } = mockFetch((c) => (c.path.endsWith('/decision') ? { body: { ...pending[0], status: 'approved' } } : undefined));
    renderWithProviders(<RequestQueue requests={pending} />);
    expect(screen.getAllByRole('article')[0]).toHaveClass('is-selected');
    fireEvent.keyDown(document.body, { key: 'a' });
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const call = calls.find((c) => c.method === 'POST')!;
    expect(call.path).toBe('/api/requests/req_01/decision');
    expect(call.body).toEqual({ decision: 'approve' });
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
  });

  it('J moves focus to the next card and D denies it', async () => {
    const pending = [makeRequest(), makeRequest({ id: 'req_02' })];
    const { calls } = mockFetch((c) => (c.path.endsWith('/decision') ? { body: { ...pending[1], status: 'denied' } } : undefined));
    renderWithProviders(<RequestQueue requests={pending} />);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(screen.getAllByRole('article')[1]).toHaveClass('is-selected');
    fireEvent.keyDown(document.body, { key: 'd' });
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.path).toBe('/api/requests/req_02/decision'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'deny' });
  });

  it('409 already_decided shows the toast "Already decided"', async () => {
    mockFetch((c) => (c.path.endsWith('/decision') ? { status: 409, body: { error: 'already_decided' } } : undefined));
    renderWithProviders(<RequestQueue requests={[makeRequest()]} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
  });

  it('maps 410 expired, apply_failed and plaintext_not_allowed to toasts', async () => {
    const answers = [
      { status: 410, body: { error: 'expired' } },
      { status: 409, body: { error: 'apply_failed', cause: 'stale' } },
      { status: 403, body: { error: 'plaintext_not_allowed' } },
    ];
    mockFetch((c) => (c.path.endsWith('/decision') ? answers.shift() : undefined));
    renderWithProviders(<RequestQueue requests={[makeRequest()]} />);
    for (const text of ['Expired', 'Change could not be applied (secret was changed in the meantime)', 'Plaintext is not allowed for this secret']) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      });
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('clears the focus when the focused card disappears; A then does nothing until J', async () => {
    const { calls } = mockFetch((c) => (c.path.endsWith('/decision') ? { body: { ...makeRequest({ id: 'req_02' }), status: 'approved' } } : undefined));
    const r1 = makeRequest();
    const r2 = makeRequest({ id: 'req_02' });
    const { rerender } = renderWithProviders(<RequestQueue requests={[r1, r2]} />);
    expect(screen.getAllByRole('article')[0]).toHaveClass('is-selected');
    rerender(<RequestQueue requests={[r2]} />);
    expect(screen.getByRole('article')).not.toHaveClass('is-selected');
    fireEvent.keyDown(document.body, { key: 'a' });
    await act(async () => {});
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(screen.getByRole('article')).toHaveClass('is-selected');
    fireEvent.keyDown(document.body, { key: 'a' });
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.path).toBe('/api/requests/req_02/decision'));
  });

  it('shows the empty state without requests', () => {
    renderWithProviders(<RequestQueue requests={[]} />);
    expect(screen.getByText('No open requests')).toBeInTheDocument();
  });
});
