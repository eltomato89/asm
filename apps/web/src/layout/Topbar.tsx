import * as Menu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun } from 'lucide-react';
import { IconButton } from '../components/ui/Button';
import { Kbd, modKeyLabel } from '../components/ui/Kbd';
import { api, queryKeys } from '../lib/api';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useCurrentVault } from '../lib/vault';
import { AutoModePill } from './AutoModePill';
import { navItemFor } from './nav';

const THEMES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', label: 'System', icon: Monitor },
  { mode: 'light', label: 'Hell', icon: Sun },
  { mode: 'dark', label: 'Dunkel', icon: Moon },
];

export function ThemeMenu() {
  const { mode, effective, setMode } = useTheme();
  const Icon = effective === 'dark' ? Moon : Sun;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label="Darstellung">
          <Icon className="icon" strokeWidth={1.5} aria-hidden />
        </IconButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6}>
          <Menu.Label className="menu-label">Darstellung</Menu.Label>
          <Menu.RadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
            {THEMES.map((t) => (
              <Menu.RadioItem key={t.mode} value={t.mode} className="menu-item">
                <t.icon className="icon" strokeWidth={1.5} aria-hidden />
                {t.label}
                <Menu.ItemIndicator className="check">
                  <Check className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function initials(name: string): string {
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}

function UserMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.clear();
      void navigate({ to: '/login' });
    },
  });
  if (!me) return null;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className="avatar" aria-label={`Konto ${me.username}`} style={{ border: 0 }}>
          {initials(me.username)}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6}>
          <Menu.Label className="menu-label">
            Angemeldet als <span className="mono">{me.username}</span>
          </Menu.Label>
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={() => logout.mutate()}>
            <LogOut className="icon" strokeWidth={1.5} aria-hidden />
            Abmelden
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Sticky header: breadcrumb (vault / page), auto-mode segment, ⌘K button, theme and account menus. */
export function Topbar({ onMenu, onPalette }: { onMenu: () => void; onPalette: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const { vault } = useCurrentVault(vaults.data?.items);
  const page = navItemFor(pathname);
  return (
    <header className="topbar">
      <IconButton label="Navigation öffnen" className="menu-btn" onClick={onMenu}>
        <MenuIcon className="icon" strokeWidth={1.5} aria-hidden />
      </IconButton>
      <div className="crumbs">
        {vault ? (
          <>
            <span className="vault-crumb">{vault.name}</span>
            <span className="sep">/</span>
          </>
        ) : null}
        <strong>{page?.label ?? ''}</strong>
      </div>
      <span className="spacer" />
      <AutoModePill />
      <button className="cmdk-btn" type="button" aria-label="Befehlspalette öffnen" onClick={onPalette}>
        <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        <span className="label">Suchen</span>
        <Kbd>{modKeyLabel('K')}</Kbd>
      </button>
      <ThemeMenu />
      <UserMenu />
    </header>
  );
}
