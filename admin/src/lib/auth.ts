import { apiClient } from './api-client';
import type { LoginResponse } from '@/types/api';
import type { AuthMeta } from './auth-store';

interface AuthMeResponse {
  tenant: { id: string; name: string; email: string; plan: string; isActive: boolean };
  scopes: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

export interface FullLoginResult {
  token: string;
  tenant: { id: string; name: string };
  meta: AuthMeta;
}

export async function login(email: string, password: string): Promise<FullLoginResult> {
  const loginRes = await apiClient.post<{ data: LoginResponse }>('/auth/login', { email, password });
  const { token, tenant } = loginRes.data.data;

  // Temporarily attach the token so the next request is authenticated
  const meRes = await apiClient.get<{ data: AuthMeResponse }>('/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { scopes, isSuperAdmin, mustChangePassword } = meRes.data.data;

  return { token, tenant, meta: { scopes, isSuperAdmin, mustChangePassword } };
}
