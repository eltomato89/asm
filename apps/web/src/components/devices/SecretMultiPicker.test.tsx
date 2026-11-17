import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeSecret } from '../../test/fixtures';
import { mockFetch, renderWithProviders } from '../../test/utils';
import { SecretMultiPicker, type PickedSecret } from './SecretMultiPicker';

const SECRETS = [
  makeSecret(),
  makeSecret({ id: 'sec_2', title: 'Stripe', envName: 'STRIPE_KEY', vaultName: 'Work' }),
  makeSecret({ id: 'sec_3', title: 'Notes', envName: null, vaultName: 'Personal' }),
];

function Host({ initial = [], onChange }: { initial?: PickedSecret[]; onChange?: (v: PickedSecret[]) => void }) {
  const [value, setValue] = useState<PickedSecret[]>(initial);
  return (
    <SecretMultiPicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('SecretMultiPicker', () => {
  it('toggles several secrets while staying open and shows them as chips', async () => {
    const { calls } = mockFetch((c) => (c.path === '/api/secrets' ? { body: { items: SECRETS } } : undefined));
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Host onChange={onChange} />);
    expect(screen.getByText('No secrets selected yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add secrets' }));
    const list = await screen.findByRole('listbox', { name: 'Secrets' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    const call = calls.find((c) => c.path === '/api/secrets')!;
    expect(new URLSearchParams(call.search).get('status')).toBe('all');
    expect(new URLSearchParams(call.search).get('limit')).toBe('20');

    await user.click(await within(list).findByRole('option', { name: /GITHUB_TOKEN/ }));
    await user.click(within(list).getByRole('option', { name: /Notes/ }));
    expect(screen.getByRole('listbox', { name: 'Secrets' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /GITHUB_TOKEN/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('option', { name: /STRIPE_KEY/ })).toHaveAttribute('aria-selected', 'false');
    expect(onChange).toHaveBeenLastCalledWith([
      { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultName: 'Personal', addedBy: 'user', archived: false },
      { id: 'sec_3', title: 'Notes', envName: null, vaultName: 'Personal', addedBy: 'user', archived: false },
    ]);

    // Toggling again deselects.
    await user.click(within(list).getByRole('option', { name: /GITHUB_TOKEN/ }));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'sec_3' })]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    const chips = screen.getByRole('list', { name: 'Selected secrets' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(1);
    expect(chips).toHaveTextContent('Notes');
  });

  it('searches on the server', async () => {
    const { calls } = mockFetch((c) => (c.path === '/api/secrets' ? { body: { items: [] } } : undefined));
    const user = userEvent.setup();
    renderWithProviders(<Host />);
    await user.click(screen.getByRole('button', { name: 'Add secrets' }));
    await user.type(await screen.findByRole('searchbox', { name: 'Search secrets' }), 'stripe');
    await waitFor(() => expect(calls.some((c) => new URLSearchParams(c.search).get('q') === 'stripe')).toBe(true));
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
  });

  it('removes chips and marks secrets the device added', async () => {
    mockFetch(() => undefined);
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <Host
        onChange={onChange}
        initial={[
          { id: 'sec_1', title: 'GitHub', envName: 'GITHUB_TOKEN', vaultName: 'Personal', addedBy: 'user' },
          { id: 'sec_2', title: 'Stripe', envName: 'STRIPE_KEY', vaultName: 'Work', addedBy: 'device' },
        ]}
      />,
    );
    const marker = screen.getByText('created by device');
    expect(marker.closest('li')).toHaveTextContent('STRIPE_KEY');
    expect(marker).toHaveAttribute('title', 'Added automatically because this device created it.');
    await user.click(screen.getByRole('button', { name: 'Remove STRIPE_KEY' }));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'sec_1' })]);
    expect(screen.queryByText('STRIPE_KEY')).toBeNull();
  });
});
