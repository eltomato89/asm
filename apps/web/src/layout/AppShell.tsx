import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { KeyRound, Moon, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandPalette, type Command } from '../components/ui/CommandPalette';
import { api, isApiError, queryKeys, type AutoModeInput } from '../lib/api';
import { useEvents } from '../lib/sse';
import { applyTheme, effectiveTheme } from '../lib/theme';
import { useAutoModeActions } from './AutoModePill';
import { NAV_ITEMS } from './nav';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Authenticated frame: sidebar, topbar, page outlet, ⌘K palette and the live event stream. */
export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { start } = useAutoModeActions();
  useEvents();

  // Session expired mid-use: any query failing with 401 unauthenticated sends the user to the login.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (event.type === 'updated' && event.action.type === 'error' && isApiError(event.action.error, 'unauthenticated')) {
          qc.removeQueries({ queryKey: queryKeys.me });
          void navigate({ to: '/login' });
        }
      }),
    [qc, navigate],
  );

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
        group: 'Seiten',
        title: n.label,
        hint: 'Seite',
        icon: n.icon,
        keywords: n.keywords,
        run: () => void navigate({ to: n.to }),
      })),
      {
        id: 'action:auto30',
        group: 'Aktionen',
        title: 'Auto-Modus 30 min',
        icon: Zap,
        keywords: 'automatisch freigeben',
        run: () => {
          const current = qc.getQueryData<{ vaultIds: string[] | null }>(queryKeys.automode);
          const input: AutoModeInput = { minutes: 30, vaultIds: current?.vaultIds ?? null };
          start.mutate(input);
        },
      },
      {
        id: 'action:theme',
        group: 'Aktionen',
        title: 'Hell/Dunkel umschalten',
        icon: Moon,
        keywords: 'theme darstellung',
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
        group: 'Secrets',
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
