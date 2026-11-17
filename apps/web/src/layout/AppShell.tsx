import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouter } from '@tanstack/react-router';
import { KeyRound, Moon, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandPalette, type Command } from '../components/ui/CommandPalette';
import { api, isApiError, queryKeys, type AutoModeInput } from '../lib/api';
import { useEvents } from '../lib/sse';
import { applyTheme, effectiveTheme } from '../lib/theme';
import { useAutoModeActions } from './AutoModePill';
import { NAV_ITEMS } from './nav';
import { t } from '../i18n';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Authenticated frame: sidebar, topbar, page outlet, ⌘K palette and the live event stream. */
export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { start } = useAutoModeActions();
  useEvents();

  // Session expired mid-use: any query or mutation failing with 401 unauthenticated sends the user to the login,
  // remembering the current page.
  useEffect(() => {
    const toLogin = (error: unknown) => {
      if (!isApiError(error, 'unauthenticated')) return;
      const { pathname, href } = router.state.location;
      if (pathname === '/login' || router.state.status === 'pending') return; // already on the way
      qc.removeQueries({ queryKey: queryKeys.me });
      void navigate({ to: '/login', search: href && href !== '/' ? { redirect: href } : {} });
    };
    const offQueries = qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') toLogin(event.action.error);
    });
    const offMutations = qc.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') toLogin(event.action.error);
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [qc, navigate, router]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const commands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((n) => ({
        id: `page:${n.to}`,
        group: t.palette.groupPages,
        title: n.label,
        hint: t.palette.pageHint,
        icon: n.icon,
        keywords: n.keywords,
        run: () => void navigate({ to: n.to }),
      })),
      {
        id: 'action:auto30',
        group: t.palette.groupActions,
        title: t.autoMode.command30,
        icon: Zap,
        keywords: 'auto approve automatisch freigeben',
        run: () => {
          const current = qc.getQueryData<{ vaultIds: string[] | null }>(queryKeys.automode);
          const input: AutoModeInput = { minutes: 30, vaultIds: current?.vaultIds ?? null };
          start.mutate(input);
        },
      },
      {
        id: 'action:theme',
        group: t.palette.groupActions,
        title: t.palette.toggleTheme,
        icon: Moon,
        keywords: 'theme appearance dark light darstellung',
        run: () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'),
      },
    ],
    [navigate, qc, start],
  );

  const searchSecrets = useCallback(
    async (q: string, signal: AbortSignal): Promise<Command[]> => {
      const { items } = await api.searchSecrets(q, signal);
      return items.slice(0, 8).map((s) => ({
        id: `secret:${s.id}`,
        group: t.palette.groupSecrets,
        title: s.envName ?? s.title,
        mono: s.envName !== null,
        hint: s.vaultName,
        icon: KeyRound,
        run: () => void navigate({ to: '/secrets', search: { selected: s.id } }),
      }));
    },
    [navigate],
  );

  return (
    <div className={navOpen ? 'shell nav-open' : 'shell'} onClick={(e) => navOpen && !(e.target as HTMLElement).closest('.sidebar') && setNavOpen(false)}>
      <Sidebar onNavigate={() => setNavOpen(false)} />
      <div className="main">
        <Topbar onMenu={() => setNavOpen((v) => !v)} onPalette={() => setPaletteOpen(true)} />
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette commands={commands} search={searchSecrets} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
