import * as Menu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronsUpDown, KeyRound } from 'lucide-react';
import { Fragment } from 'react';
import { CountBadge } from '../components/ui/Badge';
import { api, queryKeys } from '../lib/api';
import { useCurrentVault, vaultLabel } from '../lib/vault';
import { t } from '../i18n';
import { NAV_ITEMS } from './nav';

/** Left rail: vault switcher on top, grouped navigation with the pending-requests counter (incl. standing proposals). */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const vaults = useQuery({ queryKey: queryKeys.vaults, queryFn: api.vaults });
  const pending = useQuery({ queryKey: queryKeys.requests('pending'), queryFn: () => api.requests('pending') });
  const proposals = useQuery({ queryKey: queryKeys.standingRequests('pending'), queryFn: () => api.standingRequests('pending') });
  const { vault, select } = useCurrentVault(vaults.data?.items);
  // Open access requests plus open proposals for a standing approval.
  const pendingCount = (pending.data?.items.length ?? 0) + (proposals.data?.items.filter((p) => p.status === 'pending').length ?? 0);

  return (
    <aside className="sidebar">
      <Menu.Root>
        <Menu.Trigger asChild>
          <button className="vault-switch" type="button" aria-label={t.layout.switchVault(vault ? vaultLabel(vault) : '…')}>
            <span className="logo">
              <KeyRound className="icon" strokeWidth={1.5} aria-hidden />
            </span>
            <span>
              <span className="v-name">{vault ? vaultLabel(vault) : '…'}</span>
              <br />
              <span className="v-sub mono">{window.location.host}</span>
            </span>
            <ChevronsUpDown className="icon icon-sm" strokeWidth={1.5} aria-hidden />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu" align="start" sideOffset={4} style={{ width: 216 }}>
            <Menu.Label className="menu-label">{t.nav.vaults}</Menu.Label>
            {(vaults.data?.items ?? []).map((v) => (
              <Menu.Item key={v.id} className="menu-item" onSelect={() => select(v.id)}>
                {vaultLabel(v)}
                {v.id === vault?.id ? <Check className="icon icon-sm check" strokeWidth={1.5} aria-label={t.layout.selected} /> : null}
              </Menu.Item>
            ))}
            <Menu.Separator className="menu-sep" />
            <Menu.Item className="menu-item" asChild>
              <Link to="/vaults" onClick={onNavigate}>
                {t.layout.manageVaults}
              </Link>
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>

      <nav className="nav" aria-label={t.layout.mainNav}>
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <Fragment key={to}>
            {to === '/settings' ? <div className="nav-sep" role="separator" /> : null}
            <Link to={to} activeOptions={{ exact: to === '/' }} onClick={onNavigate}>
              <Icon className="icon" strokeWidth={1.5} aria-hidden />
              {label}
              {to === '/requests' ? <CountBadge n={pendingCount} label={t.layout.pendingCount(pendingCount)} /> : null}
            </Link>
          </Fragment>
        ))}
      </nav>
    </aside>
  );
}
