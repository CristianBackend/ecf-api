import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  tenant: { id: string; name: string } | null;
  /** True once the persist middleware has read from localStorage. */
  _hasHydrated: boolean;
  setAuth: (token: string, tenant: { id: string; name: string }) => void;
  clearAuth: () => void;
  setHasHydrated: (v: boolean) => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      tenant: null,
      _hasHydrated: false,
      setAuth: (token, tenant) => set({ token, tenant }),
      clearAuth: () => set({ token: null, tenant: null }),
      setHasHydrated: (v) => set({ _hasHydrated: v }),
      isAuthenticated: () => !!get().token,
    }),
    {
      name: 'ecf-admin-auth',
      // Only persist the auth data — not the internal hydration flag.
      partialize: (state) => ({ token: state.token, tenant: state.tenant }),
      onRehydrateStorage: () => (state) => {
        // Called when localStorage data is loaded. Marks the store as ready
        // so the protected layout doesn't redirect before reading the token.
        state?.setHasHydrated(true);
      },
    },
  ),
);
