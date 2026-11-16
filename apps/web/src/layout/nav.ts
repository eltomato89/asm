import { FolderClosed, Inbox, KeyRound, LayoutDashboard, Laptop, ScrollText, Settings2, Vault, type LucideIcon } from 'lucide-react';

export type NavPath = '/' | '/requests' | '/secrets' | '/projects' | '/vaults' | '/devices' | '/audit' | '/settings';
export type NavItem = { to: NavPath; label: string; icon: LucideIcon; keywords?: string };

/** Main navigation (sidebar, breadcrumbs, command palette). Einstellungen sits below a separator. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Übersicht', icon: LayoutDashboard, keywords: 'dashboard start' },
  { to: '/requests', label: 'Anfragen', icon: Inbox, keywords: 'freigabe' },
  { to: '/secrets', label: 'Secrets', icon: KeyRound },
  { to: '/projects', label: 'Projekte', icon: FolderClosed },
  { to: '/vaults', label: 'Tresore', icon: Vault },
  { to: '/devices', label: 'Geräte', icon: Laptop, keywords: 'agents koppeln' },
  { to: '/audit', label: 'Audit-Log', icon: ScrollText, keywords: 'protokoll' },
  { to: '/settings', label: 'Einstellungen', icon: Settings2, keywords: 'passkeys konto' },
];

export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((n) => (n.to === '/' ? pathname === '/' : pathname === n.to || pathname.startsWith(`${n.to}/`)));
}
