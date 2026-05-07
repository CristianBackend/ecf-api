import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios';
import { toast } from 'sonner';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor: inject Bearer token from localStorage
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('ecf-admin-auth');
      const parsed = raw ? JSON.parse(raw) : null;
      const token: string | undefined = parsed?.state?.token;
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    } catch {
      // Silently ignore parse errors
    }
  }
  return config;
});

// Response interceptor: handle auth and billing errors globally
apiClient.interceptors.response.use(
  (res) => res,
  (error: AxiosError<{ error?: { message?: string } }>) => {
    if (typeof window === 'undefined') return Promise.reject(error);

    const status = error.response?.status;

    if (status === 401) {
      localStorage.removeItem('ecf-admin-auth');
      window.location.href = '/login';
      return Promise.reject(error);
    }

    if (status === 402) {
      const msg =
        error.response?.data?.error?.message ??
        'Plan vencido o límite de facturas alcanzado';

      toast.error(`No se pudo crear la factura: ${msg}`, {
        duration: Infinity, // persistent — user must dismiss
        action: {
          label: 'Ver mi plan',
          onClick: () => { window.location.href = '/settings?tab=plan'; },
        },
      });

      // Only redirect normal tenants (not admins — admins are exempt and
      // should not see a 402 from the guard, but guard it defensively).
      try {
        const raw = localStorage.getItem('ecf-admin-auth');
        const parsed = raw ? (JSON.parse(raw) as { state?: { isSuperAdmin?: boolean } }) : null;
        if (!parsed?.state?.isSuperAdmin) {
          window.location.href = '/settings?tab=plan';
        }
      } catch {
        window.location.href = '/settings?tab=plan';
      }
    }

    return Promise.reject(error);
  },
);

// Helper: unwrap { success, data } envelope
export async function api<T>(
  fn: () => Promise<{ data: { data: T } }>,
): Promise<T> {
  const res = await fn();
  return (res.data as { data: T }).data;
}
