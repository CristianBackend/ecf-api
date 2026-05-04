'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Key, Webhook, FileText, Shield } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/utils';
import type { TenantDetail } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

async function fetchTenant(id: string): Promise<TenantDetail> {
  const res = await apiClient.get<{ data: TenantDetail }>(`/admin/tenants/${id}`);
  return res.data.data;
}

export default function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', id],
    queryFn: () => fetchTenant(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{data.name}</h1>
            <Badge variant={data.isActive ? 'success' : 'secondary'}>{data.isActive ? 'Activo' : 'Inactivo'}</Badge>
            <Badge variant="outline">{data.plan}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{data.email} · ID: {data.id}</p>
        </div>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Empresas', value: data.companies?.length ?? 0, icon: Building2 },
          { label: 'API Keys', value: data.apiKeys?.length ?? 0, icon: Key },
          { label: 'Webhooks', value: data.webhooks?.length ?? 0, icon: Webhook },
          { label: 'Facturas totales', value: data.metrics?.invoiceTotal ?? 0, icon: FileText },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-xl font-bold">{fmtNumber(value)}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Empresas */}
      <Card>
        <CardHeader><CardTitle className="text-base flex gap-2"><Building2 className="h-5 w-5" /> Empresas</CardTitle></CardHeader>
        <CardContent className="p-0">
          {data.companies?.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Sin empresas registradas</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['RNC', 'Razón Social', 'Ambiente', 'Estado', 'Creado'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.companies?.map((c) => (
                  <tr key={c.id} className="border-b">
                    <td className="px-4 py-2 font-mono text-xs">{c.rnc}</td>
                    <td className="px-4 py-2">{c.businessName}</td>
                    <td className="px-4 py-2"><Badge variant="outline">{c.dgiiEnv}</Badge></td>
                    <td className="px-4 py-2"><Badge variant={c.isActive ? 'success' : 'secondary'}>{c.isActive ? 'Activa' : 'Inactiva'}</Badge></td>
                    <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* API Keys */}
      <Card>
        <CardHeader><CardTitle className="text-base flex gap-2"><Key className="h-5 w-5" /> API Keys</CardTitle></CardHeader>
        <CardContent className="p-0">
          {data.apiKeys?.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Sin API keys</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Nombre', 'Prefijo', 'Tipo', 'Scopes', 'Estado', 'Último uso'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.apiKeys?.map((k) => (
                  <tr key={k.id} className="border-b">
                    <td className="px-4 py-2 font-medium">{k.name}</td>
                    <td className="px-4 py-2 font-mono text-xs">{k.keyPrefix}…</td>
                    <td className="px-4 py-2"><Badge variant={k.isLive ? 'default' : 'secondary'}>{k.isLive ? 'Live' : 'Test'}</Badge></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{k.scopes.join(', ')}</td>
                    <td className="px-4 py-2"><Badge variant={k.isActive ? 'success' : 'destructive'}>{k.isActive ? 'Activa' : 'Revocada'}</Badge></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Info adicional */}
      <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">
        <span>Creado: {fmtDateTime(data.createdAt)}</span>
        <span>Actualizado: {fmtDateTime(data.updatedAt)}</span>
        <span>Facturas este mes: {fmtNumber(data.metrics?.invoiceThisMonth)}</span>
      </div>
    </div>
  );
}
