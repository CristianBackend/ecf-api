'use client';
import { useAuthStore } from '@/lib/auth-store';

export function useAuth() {
  const {
    token,
    tenant,
    scopes,
    isSuperAdmin,
    mustChangePassword,
    _hasHydrated,
    isAuthenticated,
    setMustChangePassword,
    clearAuth,
  } = useAuthStore();

  return {
    token,
    tenant,
    scopes,
    isSuperAdmin,
    mustChangePassword,
    isHydrated: _hasHydrated,
    isAuthenticated: isAuthenticated(),
    setMustChangePassword,
    clearAuth,
    hasScope: (scope: string) =>
      scopes.includes(scope) || scopes.includes('FULL_ACCESS') || isSuperAdmin,
  };
}
