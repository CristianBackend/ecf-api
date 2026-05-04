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

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      tenant: null,
      ...DEFAULT_META,
      _hasHydrated: false,
      setAuth: (token, tenant, meta) => set({ token, tenant, ...meta }),
      setMustChangePassword: (v) => set({ mustChangePassword: v }),
      clearAuth: () => set({ token: null, tenant: null, ...DEFAULT_META }),
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
      },
    },
  ),
);
