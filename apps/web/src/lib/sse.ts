import type { AccessRequestDto, AutoModeDto } from '@asm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './api';

export type ServerEvent =
  | { type: 'request.created' | 'request.updated'; data: AccessRequestDto }
  | { type: 'automode.changed'; data: AutoModeDto };

type Listener = (e: ServerEvent) => void;

const EVENT_TYPES = ['request.created', 'request.updated', 'automode.changed'] as const;
export const SSE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

const listeners = new Set<Listener>();

/** Subscribe to live server events (requires useEvents() mounted once, e.g. in the AppShell). */
export function subscribeEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hook form of subscribeEvents; the latest handler is always used. */
export function useEventSubscription(fn: Listener): void {
  useEffect(() => subscribeEvents(fn), [fn]);
}

/**
 * Opens the SSE stream /api/events, reconnects with exponential backoff and feeds the query cache:
 * request events invalidate request lists, automode.changed replaces the auto mode state.
 */
export function useEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const dispatch = (event: ServerEvent) => {
      if (event.type === 'automode.changed') qc.setQueryData(queryKeys.automode, event.data);
      else void qc.invalidateQueries({ queryKey: queryKeys.requestsAll });
      for (const fn of [...listeners]) {
        try {
          fn(event);
        } catch {
          // a failing subscriber must not break the stream
        }
      }
    };

    const connect = () => {
      const source = new EventSource('/api/events', { withCredentials: true });
      es = source;
      source.onopen = () => {
        if (attempt > 0) {
          // Events may have been missed while disconnected.
          void qc.invalidateQueries({ queryKey: queryKeys.requestsAll });
          void qc.invalidateQueries({ queryKey: queryKeys.automode });
        }
        attempt = 0;
      };
      source.onerror = () => {
        source.close();
        if (disposed) return;
        const delay = SSE_BACKOFF_MS[Math.min(attempt, SSE_BACKOFF_MS.length - 1)]!;
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (msg) => {
          try {
            dispatch({ type, data: JSON.parse((msg as MessageEvent<string>).data) } as ServerEvent);
          } catch {
            // ignore malformed frames
          }
        });
      }
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [qc]);
}
