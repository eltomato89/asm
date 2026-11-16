import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/utils';
import { CommandPalette, type Command } from './CommandPalette';

function commands(run = vi.fn()): Command[] {
  return [
    { id: 'overview', group: 'Seiten', title: 'Übersicht', run },
    { id: 'secrets', group: 'Seiten', title: 'Secrets', run },
    { id: 'audit', group: 'Seiten', title: 'Audit-Log', run },
    { id: 'auto30', group: 'Aktionen', title: 'Auto-Modus 30 min', run },
  ];
}

describe('CommandPalette', () => {
  it('opens with Meta+K and filters', async () => {
    const run = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette commands={commands(run)} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Befehlspalette' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);

    await user.keyboard('audit');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Audit-Log')]);

    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens with Ctrl+K, navigates with arrows and shows an empty state', async () => {
    const run = vi.fn();
    const user = userEvent.setup();
    const cmds = commands(run);
    renderWithProviders(<CommandPalette commands={cmds} />);
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('zzzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/Nichts gefunden/)).toBeInTheDocument();
  });

  it('adds async search results (debounced) and runs them', async () => {
    const pick = vi.fn();
    const search = vi.fn(async (q: string): Promise<Command[]> => [
      { id: 'sec_1', group: 'Secrets', title: 'GITHUB_TOKEN', hint: 'Persönlich', mono: true, run: () => pick(q) },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette commands={commands()} search={search} />);
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('github');
    expect(await screen.findByRole('option', { name: /GITHUB_TOKEN/ })).toBeInTheDocument();
    expect(search).toHaveBeenLastCalledWith('github', expect.any(AbortSignal));
    expect(search.mock.calls.length).toBeLessThan(6); // debounced, not per keystroke
    await user.keyboard('{Enter}');
    expect(pick).toHaveBeenCalledWith('github');
  });

  it('ignores K without modifier and Meta+K toggles closed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette commands={commands()} />);
    await user.keyboard('k');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog');
    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
