import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from '../layout/AppShell';
import { NAV_ITEMS, type NavPath } from '../layout/nav';
import { api, isApiError, queryKeys } from '../lib/api';
import { LoginPage } from './login';
import { PlaceholderPage } from './placeholder';
import { SetupPage } from './setup';

type RouterContext = { queryClient: QueryClient };

const needsSetup = async (qc: QueryClient) =>
  (await qc.ensureQueryData({ queryKey: queryKeys.setupStatus, queryFn: api.setupStatus })).needsSetup;

/** The signed-in user, or null on 401. */
async function currentUser(qc: QueryClient) {
  try {
    return await qc.ensureQueryData({ queryKey: queryKeys.me, queryFn: api.me });
  } catch (e) {
    if (isApiError(e, 'unauthenticated')) return null;
    throw e;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    if (!(await needsSetup(context.queryClient))) throw redirect({ to: '/login' });
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => {
    if (await needsSetup(context.queryClient)) throw redirect({ to: '/setup' });
    if (await currentUser(context.queryClient)) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

/** Guard for the authenticated app: setup first, then a session. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    if (await needsSetup(context.queryClient)) throw redirect({ to: '/setup' });
    if (!(await currentUser(context.queryClient))) throw redirect({ to: '/login' });
  },
  component: AppShell,
});

const titleOf = (to: NavPath) => NAV_ITEMS.find((n) => n.to === to)!.label;

const pageRoutes = NAV_ITEMS.filter((n) => n.to !== '/secrets').map((n) =>
  createRoute({ getParentRoute: () => appRoute, path: n.to, component: () => <PlaceholderPage title={titleOf(n.to)} /> }),
);

/** /secrets?selected=<id> — the command palette deep-links secrets here (detail view: Task 13). */
const secretsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/secrets',
  validateSearch: (search: Record<string, unknown>): { selected?: string } =>
    typeof search.selected === 'string' && search.selected ? { selected: search.selected } : {},
  component: () => <PlaceholderPage title={titleOf('/secrets')} />,
});

const routeTree = rootRoute.addChildren([setupRoute, loginRoute, appRoute.addChildren([...pageRoutes, secretsRoute])]);

export function createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: opts.queryClient },
    ...(opts.history ? { history: opts.history } : {}),
    defaultPreload: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
