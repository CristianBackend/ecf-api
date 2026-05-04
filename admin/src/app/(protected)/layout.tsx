'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth-store';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, _hasHydrated } = useAuthStore();

  useEffect(() => {
    // Wait for Zustand persist to read localStorage before checking auth.
    // Without this guard the layout redirects to /login on every page load
    // because the store starts with token=null and only hydrates asynchronously.
    if (!_hasHydrated) return;
    if (!isAuthenticated()) {
      router.push('/login');
    }
  }, [_hasHydrated, isAuthenticated, router]);

  // Show a spinner while Zustand hydrates from localStorage to avoid a flash
  // of unauthenticated content or a premature redirect to /login.
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
      <div className="hidden md:flex md:shrink-0">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
