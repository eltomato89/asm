import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/utils';
import { REVEAL_TTL_MS, SecretValue } from './SecretValue';

const flush = () => act(async () => {});

describe('SecretValue', () => {
  it('is masked by default and hides the value again after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reveal = vi.fn(async () => ({ value: 'geheim-a' }));
    renderWithProviders(<SecretValue identity="sec_a" reveal={reveal} />);
    expect(screen.queryByText('geheim-a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    await flush();
    expect(screen.getByText('geheim-a')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(REVEAL_TTL_MS - 1));
    expect(screen.getByText('geheim-a')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('geheim-a')).toBeNull();
    // needs a new reveal afterwards
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    await flush();
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('clears its timer on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { unmount } = renderWithProviders(<SecretValue identity="sec_a" reveal={async () => ({ value: 'x' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the value when the identity changes and copies the current secret', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { rerender } = renderWithProviders(<SecretValue identity="sec_a" reveal={async () => ({ value: 'geheim-a' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    await flush();
    expect(screen.getByText('geheim-a')).toBeInTheDocument();
    rerender(<SecretValue identity="sec_b" reveal={async () => ({ value: 'geheim-b' })} />);
    await flush();
    expect(screen.queryByText('geheim-a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await flush();
    expect(writeText).toHaveBeenCalledWith('geheim-b');
    expect(writeText).not.toHaveBeenCalledWith('geheim-a');
  });
});
