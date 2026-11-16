import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from './api';
import { subscribeEvents, useEvents } from './sse';
import { makeQueryClient } from '../test/utils';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function Probe() {
  useEvents();
  return null;
}

const last = () => FakeEventSource.instances.at(-1)!;

describe('useEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('connects to /api/events with credentials and updates the query cache', () => {
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.requests('pending'), { items: [] });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const es = last();
    expect(es.url).toBe('/api/events');
    expect(es.init?.withCredentials).toBe(true);

    const dto = { active: true, enabledUntil: 123, defaultDurationMin: 30, vaultIds: null };
    act(() => es.emit('automode.changed', dto));
    expect(qc.getQueryData(queryKeys.automode)).toEqual(dto);

    act(() => es.emit('request.created', { id: 'req_1' }));
    expect(qc.getQueryState(queryKeys.requests('pending'))?.isInvalidated).toBe(true);
  });

  it('notifies subscribers', () => {
    const qc = makeQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const seen: string[] = [];
    const off = subscribeEvents((e) => seen.push(`${e.type}:${(e.data as { id: string }).id}`));
    act(() => last().emit('request.updated', { id: 'req_9' }));
    off();
    act(() => last().emit('request.updated', { id: 'req_10' }));
    expect(seen).toEqual(['request.updated:req_9']);
  });

  it('reconnects with exponential backoff and resets after a successful open', () => {
    vi.useFakeTimers();
    const qc = makeQueryClient();
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => last().onerror?.());
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => last().onerror?.());
    act(() => vi.advanceTimersByTime(1999));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(3);

    act(() => last().onopen?.());
    act(() => last().onerror?.());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeEventSource.instances).toHaveLength(4);

    unmount();
    expect(last().closed).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it('refreshes requests and auto mode after reconnecting (events may have been missed)', () => {
    vi.useFakeTimers();
    const qc = makeQueryClient();
    qc.setQueryData(queryKeys.automode, { active: false, enabledUntil: null, defaultDurationMin: 30, vaultIds: null });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    act(() => last().onerror?.());
    act(() => vi.advanceTimersByTime(1000));
    act(() => last().onopen?.());
    expect(qc.getQueryState(queryKeys.automode)?.isInvalidated).toBe(true);
  });
});
