import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  token: string | null;
  tenant: { id: string; name: string } | null;
  setAuth: (token: string, tenant: { id: string; name: string }) => void;
  clearAuth: () => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      tenant: null,
      setAuth: (token, tenant) => set({ token, tenant }),
      clearAuth: () => set({ token: null, tenant: null }),
      isAuthenticated: () => !!get().token,
    }),
    {
      name: 'ecf-admin-auth',
    },
  ),
);
