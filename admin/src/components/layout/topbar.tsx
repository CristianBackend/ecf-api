'use client';

import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { LogOut, Sun, Moon, Monitor, User, Menu } from 'lucide-react';
import { useAuthStore } from '@/lib/auth-store';
import { Button } from '@/components/ui/button';

export function Topbar({ title, onMenuClick }: { title?: string; onMenuClick?: () => void }) {
  const router = useRouter();
  const { tenant, clearAuth } = useAuthStore();
  const { theme, setTheme } = useTheme();

  function handleLogout() {
    clearAuth();
    router.push('/login');
  }

  const themeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const ThemeIcon = themeIcon;
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4 sm:px-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-8 w-8"
          onClick={onMenuClick}
          aria-label="Abrir menú"
        >
          <Menu className="h-5 w-5" />
        </Button>
        {title && <h2 className="font-semibold text-sm sm:text-base truncate">{title}</h2>}
      </div>

      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(nextTheme)}
          aria-label="Cambiar tema"
          className="h-8 w-8"
        >
          <ThemeIcon className="h-4 w-4" />
        </Button>

        {/* User menu */}
        <div className="flex items-center gap-2 pl-2 border-l border-border">
          <div className="hidden sm:flex flex-col items-end text-right">
            <span className="text-xs font-medium leading-none">{tenant?.name ?? 'Admin'}</span>
          </div>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-semibold shrink-0">
            <User className="h-4 w-4" />
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Cerrar sesión" className="h-8 w-8">
            <LogOut className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </header>
  );
}
