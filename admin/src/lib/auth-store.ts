import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthMeta {
  scopes: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

interface AuthState extends AuthMeta {
  token: string | null;
  tenant: { id: string; name: string } | null;
  _hasHydrated: boolean;
  setAuth: (token: string, tenant: { id: string; name: string }, meta: AuthMeta) => void;
  setMustChangePassword: (v: boolean) => void;
  clearAuth: () => void;
  setHasHydrated: (v: boolean) => void;
  isAuthenticated: () => boolean;
}

const DEFAULT_META: AuthMeta = { scopes: [], isSuperAdmin: false, mustChangePassword: false };

/**
 * FIX 2: mirror the backend-derived `isSuperAdmin` flag into a cookie so the
 * server-side `proxy.ts` can gate admin routes BEFORE render. Defense-in-depth
 * only — the backend (@RequireScopes(ADMIN) → 403) remains the real boundary.
 */
function syncAdminCookie(isSuperAdmin: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = `ecf-admin=${isSuperAdmin ? '1' : '0'}; path=/; max-age=86400; samesite=lax`;
}
function clearAdminCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = 'ecf-admin=; path=/; max-age=0; samesite=lax';
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      tenant: null,
      ...DEFAULT_META,
      _hasHydrated: false,
      setAuth: (token, tenant, meta) => {
        set({ token, tenant, ...meta });
        syncAdminCookie(meta.isSuperAdmin);
      },
      setMustChangePassword: (v) => set({ mustChangePassword: v }),
      clearAuth: () => {
        set({ token: null, tenant: null, ...DEFAULT_META });
        clearAdminCookie();
      },
      setHasHydrated: (v) => set({ _hasHydrated: v }),
      isAuthenticated: () => !!get().token,
    }),
    {
      name: 'ecf-admin-auth',
      partialize: (state) => ({
        token: state.token,
        tenant: state.tenant,
        scopes: state.scopes,
        isSuperAdmin: state.isSuperAdmin,
        mustChangePassword: state.mustChangePassword,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
        // Re-establish the admin cookie for an already-persisted session so the
        // proxy sees it on subsequent navigations after a reload.
        if (state) syncAdminCookie(state.isSuperAdmin);
      },
    },
  ),
);
