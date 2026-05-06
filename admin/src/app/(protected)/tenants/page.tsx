'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Search, Plus, ChevronRight } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtNumber } from '@/lib/utils';
import type { Tenant, Paginated } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

async function fetchTenants(page: number, limit: number, search: string, plan: string, isActive: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search) params.set('search', search);
  if (plan) params.set('plan', plan);
  if (isActive) params.set('isActive', isActive);
  const res = await apiClient.get<{ data: Paginated<Tenant> }>(`/admin/tenants?${params}`);
  return res.data.data;
}

const PLAN_COLORS: Record<string, string> = {
  STARTER: 'secondary', BUSINESS: 'info', ENTERPRISE: 'warning', PLATFORM: 'default',
};

export default function TenantsPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [isActive, setIsActive] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Debounce
  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    clearTimeout((handleSearch as { timer?: ReturnType<typeof setTimeout> }).timer);
    (handleSearch as { timer?: ReturnType<typeof setTimeout> }).timer = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', page, limit, debouncedSearch, plan, isActive],
    queryFn: () => fetchTenants(page, limit, debouncedSearch, plan, isActive),
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data ? `${fmtNumber(data.total)} tenants registrados` : 'Cargando…'}
          </p>
        </div>
        {/* Navigate to dedicated creation page (POST /admin/tenants, not /tenants/register) */}
        <Button className="gap-2" onClick={() => router.push('/tenants/new')}>
          <Plus className="h-4 w-4" /> Nuevo Tenant
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre o email…"
            className="pl-9"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <select
          value={plan}
          onChange={(e) => { setPlan(e.target.value); setPage(1); }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos los planes</option>
          {['STARTER', 'BUSINESS', 'ENTERPRISE', 'PLATFORM'].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={isActive}
          onChange={(e) => { setIsActive(e.target.value); setPage(1); }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Todos</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Nombre / Email', 'Plan', 'Estado', 'Empresas', 'Facturas', 'Creado', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b">
                        {Array.from({ length: 7 }).map((__, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  : data?.items.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => router.push(`/tenants/${t.id}`)}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium">{t.name}</p>
                          <p className="text-xs text-muted-foreground">{t.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={(PLAN_COLORS[t.plan] ?? 'secondary') as 'secondary'}>{t.plan}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={t.isActive ? 'success' : 'secondary'}>
                            {t.isActive ? 'Activo' : 'Inactivo'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-center">{t._count?.companies ?? '—'}</td>
                        <td className="px-4 py-3 text-center">{fmtNumber(t._count?.invoices)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(t.createdAt)}</td>
                        <td className="px-4 py-3">
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">
                Pág. {page} de {data.totalPages} · {fmtNumber(data.total)} total
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>Anterior</Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= data.totalPages}>Siguiente</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
