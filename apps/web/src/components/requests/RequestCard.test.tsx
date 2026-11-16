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
    expect(card).toHaveTextContent('claude@mbp-office möchte GITHUB_TOKEN für agent-secrets-manager.');
    expect(within(card).getByText('Release-Workflow pushen').tagName).toBe('P');
    expect(within(card).getByText('Release-Workflow pushen')).toHaveClass('req-reason');
    expect(card).toHaveTextContent('via CLI-Übergabe');
  });

  it('shows "Klartext an Agent" for plaintext delivery and the title when there is no ENV name', () => {
    renderWithProviders(
      <RequestCard request={makeRequest({ delivery: 'plaintext', secret: { id: 's', title: 'Stripe Key', envName: null, vaultId: 'v', vaultName: 'P' } })} now={T0} onDecide={vi.fn()} />,
    );
    expect(screen.getByRole('article')).toHaveTextContent('möchte Stripe Key für');
    expect(screen.getByRole('article')).toHaveTextContent('Klartext an Agent');
  });

  it('time bar width is proportional to the remaining time', () => {
    const { rerender } = renderWithProviders(<RequestCard request={makeRequest()} now={T0 + 60_000} onDecide={vi.fn()} />);
    const bar = () => screen.getByRole('progressbar', { name: 'Verbleibende Zeit' });
    expect(bar().firstElementChild).toHaveStyle({ width: '80%' });
    expect(bar()).toHaveAttribute('aria-valuenow', '240');
    expect(screen.getByRole('article')).toHaveTextContent('läuft ab in 4:00');
    rerender(<RequestCard request={makeRequest()} now={T0 + 225_000} onDecide={vi.fn()} />);
    expect(bar().firstElementChild).toHaveStyle({ width: '25%' });
  });

  it('update card shows the metadata diff "Titel: alt → neu" and „Wert wird geändert“', () => {
    renderWithProviders(
      <RequestCard
        request={makeRequest({ kind: 'update', delivery: null, metaDiff: { title: { from: 'Stripe alt', to: 'Stripe neu' } }, valueChanged: true })}
        now={T0}
        onDecide={vi.fn()}
      />,
    );
    const card = screen.getByRole('article');
    expect(card).toHaveTextContent('claude@mbp-office möchte GITHUB_TOKEN ändern.');
    const diff = within(card).getByRole('definition', { name: 'Titel' });
    expect(diff).toHaveTextContent('Stripe alt→Stripe neu');
    expect(within(card).getByText('Titel')).toBeInTheDocument();
    expect(card).toHaveTextContent('Wert wird geändert');
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
    expect(await screen.findByText(/Freigegeben/)).toBeInTheDocument();
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

  it('409 already_decided shows the toast „Bereits entschieden“', async () => {
    mockFetch((c) => (c.path.endsWith('/decision') ? { status: 409, body: { error: 'already_decided' } } : undefined));
    renderWithProviders(<RequestQueue requests={[makeRequest()]} />);
    fireEvent.click(screen.getByRole('button', { name: /Freigeben/ }));
    expect(await screen.findByText('Bereits entschieden')).toBeInTheDocument();
  });

  it('maps 410 expired, apply_failed and plaintext_not_allowed to German toasts', async () => {
    const answers = [
      { status: 410, body: { error: 'expired' } },
      { status: 409, body: { error: 'apply_failed', cause: 'stale' } },
      { status: 403, body: { error: 'plaintext_not_allowed' } },
    ];
    mockFetch((c) => (c.path.endsWith('/decision') ? answers.shift() : undefined));
    renderWithProviders(<RequestQueue requests={[makeRequest()]} />);
    for (const text of ['Abgelaufen', 'Änderung konnte nicht übernommen werden (Secret wurde inzwischen geändert)', 'Klartext für dieses Secret nicht erlaubt']) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Freigeben/ }));
      });
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('shows the empty state without requests', () => {
    renderWithProviders(<RequestQueue requests={[]} />);
    expect(screen.getByText('Keine offenen Anfragen')).toBeInTheDocument();
  });
});
