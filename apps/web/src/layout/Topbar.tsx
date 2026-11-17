import * as Menu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun } from 'lucide-react';
import { IconButton } from '../components/ui/Button';
import { Kbd, modKeyLabel } from '../components/ui/Kbd';
import { api, queryKeys } from '../lib/api';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useCurrentVault, vaultLabel } from '../lib/vault';
import { t } from '../i18n';
import { AutoModePill } from './AutoModePill';
import { navItemFor } from './nav';

/** `label` is a getter so it follows the active locale. */
const THEMES: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'system', get label() { return t.layout.themeSystem; }, icon: Monitor },
  { mode: 'light', get label() { return t.layout.themeLight; }, icon: Sun },
  { mode: 'dark', get label() { return t.layout.themeDark; }, icon: Moon },
];

export function ThemeMenu() {
  const { mode, effective, setMode } = useTheme();
  const Icon = effective === 'dark' ? Moon : Sun;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label={t.layout.appearance}>
          <Icon className="icon" strokeWidth={1.5} aria-hidden />
        </IconButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6}>
          <Menu.Label className="menu-label">{t.layout.appearance}</Menu.Label>
          <Menu.RadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
            {THEMES.map((th) => (
              <Menu.RadioItem key={th.mode} value={th.mode} className="menu-item">
                <th.icon className="icon" strokeWidth={1.5} aria-hidden />
                {th.label}
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
        <button type="button" className="avatar" aria-label={t.layout.account(me.username)} style={{ border: 0 }}>
          {initials(me.username)}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6}>
          <Menu.Label className="menu-label">
            {t.layout.signedInAs} <span className="mono">{me.username}</span>
          </Menu.Label>
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={() => logout.mutate()}>
            <LogOut className="icon" strokeWidth={1.5} aria-hidden />
            {t.layout.signOut}
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
      <IconButton label={t.layout.openNav} className="menu-btn" onClick={onMenu}>
        <MenuIcon className="icon" strokeWidth={1.5} aria-hidden />
      </IconButton>
      <div className="crumbs">
        {vault ? (
          <>
            <span className="vault-crumb">{vaultLabel(vault)}</span>
            <span className="sep">/</span>
          </>
        ) : null}
        <strong>{page?.label ?? ''}</strong>
      </div>
      <span className="spacer" />
      <AutoModePill />
      <button className="cmdk-btn" type="button" aria-label={t.layout.openPalette} onClick={onPalette}>
        <Search className="icon icon-sm" strokeWidth={1.5} aria-hidden />
        <span className="label">{t.common.search}</span>
        <Kbd>{modKeyLabel('K')}</Kbd>
      </button>
      <ThemeMenu />
      <UserMenu />
    </header>
  );
}
