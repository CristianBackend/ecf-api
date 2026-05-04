import { apiClient } from './api-client';
import type { LoginResponse } from '@/types/api';

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await apiClient.post<{ data: LoginResponse }>('/auth/login', { email, password });
  return res.data.data;
}
