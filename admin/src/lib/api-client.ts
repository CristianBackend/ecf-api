import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

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

// Response interceptor: on 401, clear auth and redirect to /login
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('ecf-admin-auth');
      window.location.href = '/login';
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
