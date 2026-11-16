import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type ErrorComponentProps,
  type RouterHistory,
} from '@tanstack/react-router';
import { Button } from '../components/ui/Button';
import { AppShell } from '../layout/AppShell';
import { api, isApiError, queryKeys } from '../lib/api';
import { ActivatePage } from './activate';
import { ApprovePage } from './approve';
import { AuditPage, validateAuditSearch } from './audit';
import { ConnectPage } from './connect';
import { DevicesPage } from './devices';
import { LoginPage } from './login';
import { ProjectsPage } from './projects';
import { RequestsPage } from './requests';
import { SecretsPage } from './secrets';
import { SettingsPage } from './settings';
import { SetupPage } from './setup';
import { VaultsPage } from './vaults';

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

/**
 * Only same-origin paths are accepted as post-login targets: a string starting with "/", without control
 * characters or backslashes, that resolves to this origin and whose normalized path does not start with "//"
 * (rejects `//host`, `/\\host`, `/.//host`, absolute URLs).
 */
export function safeRedirect(target: unknown): string | undefined {
  if (typeof target !== 'string' || !target.startsWith('/') || target.length > 2000) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return undefined;
  try {
    const origin = window.location.origin;
    const url = new URL(target, origin);
    // The normalized path must not start with "//" (e.g. "/.//evil.com" → "//evil.com", a protocol-relative URL).
    if (url.origin !== origin || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) return undefined;
    return url.pathname + url.search + url.hash;
  } catch {
    return undefined;
  }
}

/** Shared guard: setup first, then a session; remembers the target for after the login. */
async function requireSession(qc: QueryClient, href: string) {
  if (await needsSetup(qc)) throw redirect({ to: '/setup' });
  if (!(await currentUser(qc))) throw redirect({ to: '/login', search: href && href !== '/' ? { redirect: href } : {} });
}

/** Router-level error state (German), e.g. when a page throws while rendering. */
export function RouteError({ error }: Partial<ErrorComponentProps>) {
  return (
    <div className="consent-page">
      <div className="consent">
        <div className="consent-result">
          <h2>Etwas ist schiefgelaufen</h2>
          <p>Diese Ansicht konnte nicht angezeigt werden. Lade die Seite neu. Bleibt der Fehler, prüfe die Verbindung zum Server.</p>
          {error instanceof Error && error.message ? <p className="mono faint">{error.message}</p> : null}
          <p style={{ marginTop: 16 }}>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Neu laden
            </Button>
          </p>
        </div>
      </div>
    </div>
  );
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
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const r = safeRedirect(search.redirect);
    return r ? { redirect: r } : {};
  },
  beforeLoad: async ({ context, search }) => {
    if (await needsSetup(context.queryClient)) throw redirect({ to: '/setup' });
    if (await currentUser(context.queryClient)) throw redirect({ href: search.redirect ?? '/' });
  },
  component: () => <LoginPage redirectTo={loginRoute.useSearch().redirect} />,
});

/**
 * Public approve page opened from a push notification: no guard at all (no setup/session lookups),
 * the token in the URL is the only credential. Reachable from outside the home network.
 */
const approveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approve/$token',
  component: () => <ApprovePage token={approveRoute.useParams().token} />,
});

/** Signed-in pages without the app shell (pairing flows opened from a terminal). */
const bareRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'bare',
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: Outlet,
});

const connectRoute = createRoute({
  getParentRoute: () => bareRoute,
  path: '/connect',
  validateSearch: (search: Record<string, unknown>): { req?: string } => (typeof search.req === 'string' && search.req ? { req: search.req } : {}),
  component: () => <ConnectPage req={connectRoute.useSearch().req} />,
});

const activateRoute = createRoute({
  getParentRoute: () => bareRoute,
  path: '/activate',
  validateSearch: (search: Record<string, unknown>): { code?: string } => (typeof search.code === 'string' && search.code ? { code: search.code } : {}),
  component: () => <ActivatePage initialCode={activateRoute.useSearch().code} />,
});

/** Guard for the authenticated app: setup first, then a session. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href),
  component: AppShell,
});

const selectedSearch = (search: Record<string, unknown>): { selected?: string } =>
  typeof search.selected === 'string' && search.selected ? { selected: search.selected } : {};

const overviewRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => <RequestsPage variant="overview" /> });
const requestsRoute = createRoute({ getParentRoute: () => appRoute, path: '/requests', component: () => <RequestsPage variant="requests" /> });

/** /secrets?selected=<id> — the command palette deep-links secrets here. */
const secretsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/secrets',
  validateSearch: selectedSearch,
  component: () => <SecretsPage selected={secretsRoute.useSearch().selected} />,
});
const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  validateSearch: selectedSearch,
  component: () => <ProjectsPage selected={projectsRoute.useSearch().selected} />,
});
const vaultsRoute = createRoute({ getParentRoute: () => appRoute, path: '/vaults', component: VaultsPage });
const devicesRoute = createRoute({ getParentRoute: () => appRoute, path: '/devices', component: DevicesPage });
const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit',
  validateSearch: validateAuditSearch,
  component: () => <AuditPage search={auditRoute.useSearch()} />,
});
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage });

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  approveRoute,
  bareRoute.addChildren([connectRoute, activateRoute]),
  appRoute.addChildren([overviewRoute, requestsRoute, secretsRoute, projectsRoute, vaultsRoute, devicesRoute, auditRoute, settingsRoute]),
]);

export function createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: opts.queryClient },
    ...(opts.history ? { history: opts.history } : {}),
    defaultPreload: false,
    defaultErrorComponent: RouteError,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
