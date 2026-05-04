'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileStack } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { NavItem } from './nav-items';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
}

export function MobileSidebar({ open, onOpenChange, items }: Props) {
  const pathname = usePathname();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-800 pr-12">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <FileStack className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-white truncate">ECF Admin</span>
        </div>

        <nav className="flex-1 overflow-y-auto py-4">
          <ul className="space-y-1 px-2">
            {items.map(({ href, label, icon: Icon, disabled }) => {
              const active = pathname === href || (href !== '/dashboard' && href !== '/home' && pathname.startsWith(href));
              return (
                <li key={href}>
                  <Link
                    href={disabled ? '#' : href}
                    aria-disabled={disabled}
                    onClick={() => { if (!disabled) onOpenChange(false); }}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-blue-600/20 text-blue-400'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                      disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
                    )}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
