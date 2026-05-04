'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useAuthStore } from '@/lib/auth-store';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { MobileSidebar } from '@/components/layout/mobile-sidebar';
import { ForceChangePasswordModal } from '@/components/auth/force-change-password-modal';
import { ADMIN_NAV_ITEMS, TENANT_NAV_ITEMS, ADMIN_ONLY_PREFIXES } from '@/components/layout/nav-items';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, _hasHydrated, mustChangePassword, isSuperAdmin } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = isSuperAdmin ? ADMIN_NAV_ITEMS : TENANT_NAV_ITEMS;

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!isAuthenticated()) {
      router.push('/login');
      return;
    }
    // Route guard: tenant-normal users cannot visit admin-only paths
    if (!isSuperAdmin) {
      const isAdminPath = ADMIN_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
      if (isAdminPath) {
        toast.error('No tenés permiso para acceder a esa sección.');
        router.replace('/home');
      }
    }
  }, [_hasHydrated, isAuthenticated, isSuperAdmin, pathname, router]);

  if (!_hasHydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated()) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {mustChangePassword && <ForceChangePasswordModal />}

      <MobileSidebar open={mobileOpen} onOpenChange={setMobileOpen} items={navItems} />
      <div className="hidden md:flex md:shrink-0">
        <Sidebar items={navItems} />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
