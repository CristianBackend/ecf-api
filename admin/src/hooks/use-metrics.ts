import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { GlobalMetrics } from '@/types/api';

async function fetchMetrics(): Promise<GlobalMetrics> {
  const res = await apiClient.get<{ data: GlobalMetrics }>('/admin/metrics');
  return res.data.data;
}

export function useMetrics() {
  return useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: fetchMetrics,
    refetchInterval: 30_000,
  });
}
