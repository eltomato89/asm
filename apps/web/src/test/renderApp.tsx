import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { AppProviders } from '../app';
import { createAppRouter } from '../routes/router';
import { makeQueryClient } from './utils';

/** Renders the full app (providers + router) at `path` with in-memory history. */
export function renderApp(path: string) {
  const queryClient = makeQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, history });
  const result = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router, queryClient };
}
