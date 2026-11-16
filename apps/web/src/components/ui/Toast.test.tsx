import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TOAST_MS, ToastProvider, useToast } from './Toast';

function Trigger() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast('Kopiert', 'ok')}>
      go
    </button>
  );
}

describe('ToastProvider', () => {
  it('removes the toast after its lifetime and leaves no timers behind on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'go' }).click());
    expect(screen.getByText('Kopiert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(TOAST_MS));
    // leaving animation started; the removal timer is pending
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the toast completely after the exit animation', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'go' }).click());
    act(() => vi.advanceTimersByTime(TOAST_MS + 250));
    expect(screen.queryByText('Kopiert')).toBeNull();
  });
});
