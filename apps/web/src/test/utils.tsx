import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';

export type FetchCall = { method: string; path: string; search: string; body: unknown };
export type Route = (call: FetchCall) => { status?: number; body?: unknown } | undefined;

/** Stubs global fetch; `route` returns a JSON response per call (default 404 not_found). */
export function mockFetch(route: Route) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call: FetchCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = route(call) ?? { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
}

export function renderWithProviders(ui: ReactElement, queryClient = makeQueryClient()) {
  // As wrapper, so rerender() keeps the providers.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), queryClient };
}
