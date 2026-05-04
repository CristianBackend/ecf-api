'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Users, Building2, FileText, Shield, Webhook, ClipboardList,
  HeartPulse, Settings, ChevronLeft, ChevronRight, FileStack,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const NAV_ITEMS = [
  { href: '/dashboard',  label: 'Dashboard',         icon: LayoutDashboard },
  { href: '/tenants',    label: 'Tenants',            icon: Users },
  { href: '/invoices',   label: 'Facturas',           icon: FileText },
  { href: '/webhooks',   label: 'Webhooks',           icon: Webhook },
  { href: '/audit-logs', label: 'Audit Logs',         icon: ClipboardList },
  { href: '/health',     label: 'Salud del Sistema',  icon: HeartPulse },
  { href: '/settings',   label: 'Configuración',      icon: Settings, disabled: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'relative flex flex-col h-full bg-slate-900 text-slate-100 transition-all duration-300 border-r border-slate-800',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* Logo */}
      <div className={cn('flex items-center gap-3 px-4 py-5 border-b border-slate-800', collapsed && 'justify-center px-0')}>
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
          <FileStack className="w-4 h-4 text-white" />
        </div>
        {!collapsed && <span className="font-semibold text-white truncate">ECF Admin</span>}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 overflow-y-auto">
        <ul className="space-y-1 px-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon, disabled }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
            return (
              <li key={href}>
                <Link
                  href={disabled ? '#' : href}
                  aria-disabled={disabled}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-blue-600/20 text-blue-400'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                    disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
                    collapsed && 'justify-center px-0',
                  )}
                  title={collapsed ? label : undefined}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-400 hover:text-white shadow"
        aria-label={collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </button>
    </aside>
  );
}
