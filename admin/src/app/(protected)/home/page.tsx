'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { FileText, Building2, TrendingUp, Shield, Key, Plus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtNumber } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface TenantStats {
  totalInvoices: number;
  totalCompanies: number;
  invoicesThisMonth: number;
  // TODO: invoicesToday and activeCertificates not yet available from /tenants/me/stats
}

async function fetchStats(): Promise<TenantStats> {
  const res = await apiClient.get<{ data: TenantStats }>('/tenants/me/stats');
  return res.data.data;
}

function StatCard({
  label, value, sub, icon: Icon, color = 'blue',
}: { label: string; value: string | number; sub?: string; icon: React.ElementType; color?: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
    amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <p className="text-3xl font-bold mt-1">{typeof value === 'number' ? fmtNumber(value) : value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl ${colorMap[color] ?? colorMap.blue}`}>
            <Icon className="h-6 w-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { tenant } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['my', 'stats'],
    queryFn: fetchStats,
  });

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Bienvenido{tenant?.name ? `, ${tenant.name}` : ''}</h1>
        <p className="text-sm text-muted-foreground mt-1">Resumen de tu cuenta</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20" /></CardContent></Card>
          ))
        ) : (
          <>
            <StatCard
              label="Facturas totales"
              value={data?.totalInvoices ?? 0}
              icon={FileText}
              color="blue"
            />
            <StatCard
              label="Facturas este mes"
              value={data?.invoicesThisMonth ?? 0}
              icon={TrendingUp}
              color="green"
            />
            <StatCard
              label="Empresas registradas"
              value={data?.totalCompanies ?? 0}
              icon={Building2}
              color="purple"
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-base font-semibold mb-3">Acciones rápidas</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Button variant="outline" className="h-auto py-4 flex flex-col gap-2" onClick={() => router.push('/companies')}>
            <Building2 className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-medium">Gestionar Empresas</span>
          </Button>
          <Button variant="outline" className="h-auto py-4 flex flex-col gap-2" onClick={() => router.push('/certificates')}>
            <Shield className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-medium">Subir Certificado</span>
          </Button>
          <Button variant="outline" className="h-auto py-4 flex flex-col gap-2" onClick={() => router.push('/api-keys')}>
            <Key className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-medium">Gestionar API Keys</span>
          </Button>
        </div>
      </div>

      {/* Mis facturas shortcut */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Mis Facturas</h2>
        <Button size="sm" variant="ghost" onClick={() => router.push('/invoices')}>
          <Plus className="h-4 w-4 mr-1" /> Ver todas
        </Button>
      </div>
      <p className="text-sm text-muted-foreground -mt-6">
        Accedé a <button className="underline text-foreground" onClick={() => router.push('/invoices')}>Mis Facturas</button> para ver el historial completo con filtros.
      </p>
    </div>
  );
}
