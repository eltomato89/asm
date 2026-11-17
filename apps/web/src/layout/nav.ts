import { t } from '../i18n';
import { FolderClosed, Inbox, KeyRound, LayoutDashboard, Laptop, ScrollText, Settings2, Vault, type LucideIcon } from 'lucide-react';

export type NavPath = '/' | '/requests' | '/secrets' | '/projects' | '/vaults' | '/devices' | '/audit' | '/settings';
export type NavItem = { to: NavPath; label: string; icon: LucideIcon; keywords?: string };

/** Main navigation (sidebar, breadcrumbs, command palette). Settings sits below a separator.
 *  `label` is a getter so it follows the active locale. Keywords cover English and German search terms. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', get label() { return t.nav.overview; }, icon: LayoutDashboard, keywords: 'dashboard home start übersicht' },
  { to: '/requests', get label() { return t.nav.requests; }, icon: Inbox, keywords: 'approval freigabe anfragen' },
  { to: '/secrets', get label() { return t.nav.secrets; }, icon: KeyRound },
  { to: '/projects', get label() { return t.nav.projects; }, icon: FolderClosed, keywords: 'projekte' },
  { to: '/vaults', get label() { return t.nav.vaults; }, icon: Vault, keywords: 'tresore' },
  { to: '/devices', get label() { return t.nav.devices; }, icon: Laptop, keywords: 'agents pair geräte koppeln' },
  { to: '/audit', get label() { return t.nav.audit; }, icon: ScrollText, keywords: 'log history protokoll' },
  { to: '/settings', get label() { return t.nav.settings; }, icon: Settings2, keywords: 'passkeys account language einstellungen konto sprache' },
];

export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((n) => (n.to === '/' ? pathname === '/' : pathname === n.to || pathname.startsWith(`${n.to}/`)));
}
