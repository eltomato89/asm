import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoModeDto } from '@asm/shared';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../lib/api';
import { makeQueryClient, mockFetch, renderWithProviders } from '../test/utils';
import { AutoModePill } from './AutoModePill';

const T0 = Date.UTC(2026, 10, 16, 14, 0, 0);
const vaults = {
  items: [
    { id: 'vlt_p', name: 'Persönlich', personal: true, role: 'owner', members: [], createdAt: 0 },
    { id: 'vlt_w', name: 'Arbeit', personal: false, role: 'owner', members: [], createdAt: 0 },
  ],
};
const active = (until: number, vaultIds: string[] | null = null): AutoModeDto => ({ active: true, enabledUntil: until, defaultDurationMin: 30, vaultIds });
const inactive: AutoModeDto = { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null };

describe('AutoModePill', () => {
  it('shows 29:59 one second after activating 30 min and disappears at 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    const dto = active(T0 + 30 * 60_000);
    mockFetch(({ path }) => (path === '/api/automode' ? { body: dto } : path === '/api/vaults' ? { body: vaults } : undefined));
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.automode, dto);
    renderWithProviders(<AutoModePill />, qc);

    const pill = screen.getByRole('button', { name: /Auto-Modus aktiv/ });
    expect(pill).toHaveTextContent('AUTO');
    expect(pill).toHaveTextContent('30:00');

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: /Auto-Modus aktiv/ })).toHaveTextContent('29:59');

    act(() => vi.advanceTimersByTime(29 * 60_000 + 59_000));
    expect(screen.queryByRole('button', { name: /Auto-Modus aktiv/ })).toBeNull();
    expect(screen.queryByText(/\d\d:\d\d/)).toBeNull();
  });

  it('appears when the cache receives an active auto mode (automode.changed)', async () => {
    mockFetch(({ path }) => (path === '/api/automode' ? { body: inactive } : path === '/api/vaults' ? { body: vaults } : undefined));
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.automode, inactive);
    renderWithProviders(<AutoModePill />, qc);
    await waitFor(() => expect(qc.getQueryState(queryKeys.automode)?.fetchStatus).toBe('idle'));
    expect(screen.queryByRole('button', { name: /Auto-Modus aktiv/ })).toBeNull();
    act(() => qc.setQueryData(queryKeys.automode, active(Date.now() + 15 * 60_000)));
    expect(await screen.findByRole('button', { name: /Auto-Modus aktiv/ })).toHaveTextContent(/1[45]:\d\d/);
  });

  it('starts auto mode for the selected duration and vaults', async () => {
    const { calls } = mockFetch(({ method, path, body }) => {
      if (path === '/api/vaults') return { body: vaults };
      if (path === '/api/automode' && method === 'GET') return { body: inactive };
      if (path === '/api/automode' && method === 'PUT') {
        const b = body as { minutes: number; vaultIds: string[] | null };
        return { body: active(Date.now() + b.minutes * 60_000, b.vaultIds) };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<AutoModePill />);

    await user.click(await screen.findByRole('button', { name: 'Auto-Modus starten' }));
    const dialog = await screen.findByRole('dialog', { name: 'Auto-Modus' });
    await user.click(screen.getByRole('button', { name: '60 min' }));
    const all = await screen.findByRole('checkbox', { name: 'Alle Tresore' });
    expect(all).toBeChecked();
    await user.click(all); // none selected
    await user.click(screen.getByRole('checkbox', { name: 'Arbeit' }));
    await user.click(screen.getByRole('button', { name: 'Starten' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ minutes: 60, vaultIds: ['vlt_w'] });
    expect(await screen.findByRole('button', { name: /Auto-Modus aktiv/ })).toHaveTextContent(/(60:00|59:5\d)/);
    expect(dialog).not.toBeInTheDocument();
  });

  it('ends auto mode with DELETE', async () => {
    let state: AutoModeDto = active(Date.now() + 10 * 60_000);
    const { calls } = mockFetch(({ method, path }) => {
      if (path === '/api/vaults') return { body: vaults };
      if (path === '/api/automode' && method === 'DELETE') state = inactive;
      if (path === '/api/automode') return { body: state };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<AutoModePill />);
    await user.click(await screen.findByRole('button', { name: /Auto-Modus aktiv/ }));
    await user.click(await screen.findByRole('button', { name: 'Beenden' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Auto-Modus aktiv/ })).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/automode')).toBe(true);
  });
});
