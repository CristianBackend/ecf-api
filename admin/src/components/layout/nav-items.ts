import {
  LayoutDashboard, Users, FileText, Webhook, ClipboardList, HeartPulse, Settings,
  Home, Building2, Shield, Key, CreditCard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

/** Items shown to super-admins (scope ADMIN) */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: '/dashboard',  label: 'Dashboard',         icon: LayoutDashboard },
  { href: '/tenants',    label: 'Tenants',            icon: Users },
  { href: '/invoices',   label: 'Facturas Globales',  icon: FileText },
  { href: '/webhooks',   label: 'Webhooks Globales',  icon: Webhook },
  { href: '/billing',    label: 'Billing',             icon: CreditCard },
  { href: '/audit-logs', label: 'Audit Logs',         icon: ClipboardList },
  { href: '/health',     label: 'Salud del Sistema',  icon: HeartPulse },
  { href: '/settings',   label: 'Configuración',      icon: Settings },
];

/** Items shown to normal tenants (no ADMIN scope) */
export const TENANT_NAV_ITEMS: NavItem[] = [
  { href: '/home',        label: 'Inicio',            icon: Home },
  { href: '/companies',   label: 'Mis Empresas',      icon: Building2 },
  { href: '/invoices',    label: 'Mis Facturas',      icon: FileText },
  { href: '/certificates',label: 'Mis Certificados',  icon: Shield },
  { href: '/api-keys',    label: 'Mis API Keys',      icon: Key },
  { href: '/webhooks',    label: 'Mis Webhooks',      icon: Webhook },
  { href: '/settings',    label: 'Configuración',     icon: Settings },
];

/** Used internally for route protection — admin-only path prefixes */
export const ADMIN_ONLY_PREFIXES = [
  '/dashboard',
  '/tenants',
  '/billing',
  '/audit-logs',
  '/health',
];
