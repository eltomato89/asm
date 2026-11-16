import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { ReauthDialog } from './components/ReauthDialog';
import { ToastProvider } from './components/ui/Toast';
import { isApiError } from './lib/api';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // Auth/permission errors are final; network hiccups get one retry.
        retry: (count, err) => count < 1 && !(isApiError(err) && err.status < 500),
      },
    },
  });
}

/** App-wide providers: query cache, toasts, tooltips and the global re-authentication dialog. */
export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={400}>
        <ToastProvider>
          {children}
          <ReauthDialog />
        </ToastProvider>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
