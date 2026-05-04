import {
  LayoutDashboard, Users, FileText, Webhook, ClipboardList, HeartPulse, Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',  label: 'Dashboard',        icon: LayoutDashboard },
  { href: '/tenants',    label: 'Tenants',           icon: Users },
  { href: '/invoices',   label: 'Facturas',          icon: FileText },
  { href: '/webhooks',   label: 'Webhooks',          icon: Webhook },
  { href: '/audit-logs', label: 'Audit Logs',        icon: ClipboardList },
  { href: '/health',     label: 'Salud del Sistema', icon: HeartPulse },
  { href: '/settings',   label: 'Configuración',     icon: Settings },
];
