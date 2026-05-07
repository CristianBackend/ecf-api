'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  CreditCard, Clock, AlertTriangle, DollarSign, RefreshCw, TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtMoney, fmtDate } from '@/lib/utils';
import { useAuthStore } from '@/lib/auth-store';
import type { BillingDashboard, BillingPlan } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

// ── stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  color = 'blue',
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color?: 'blue' | 'amber' | 'red' | 'green';
  sub?: string;
}) {
  const colorMap = {
    blue:  'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
    red:   'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
    green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <p className="text-3xl font-bold mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl ${colorMap[color]}`}>
            <Icon className="h-6 w-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function BillingDashboardPage() {
  const router = useRouter();
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);

  useEffect(() => {
    if (isSuperAdmin === false) {
      toast.error('No tenés permiso para acceder a esa sección.');
      router.replace('/home');
    }
  }, [isSuperAdmin, router]);

  const {
    data: dashboard,
    isLoading: loadingDash,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['admin', 'billing', 'dashboard'],
    queryFn: async () => {
      const res = await apiClient.get<{ data: BillingDashboard }>('/admin/billing/dashboard');
      return res.data.data;
    },
    enabled: isSuperAdmin === true,
  });

  const { data: plans = [], isLoading: loadingPlans } = useQuery({
    queryKey: ['admin', 'billing', 'plans'],
    queryFn: async () => {
      const res = await apiClient.get<{ data: BillingPlan[] }>('/admin/plans');
      return res.data.data;
    },
    enabled: isSuperAdmin === true,
  });

  const isLoading = loadingDash || loadingPlans;

  return (
    <div className="space-y-8 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-sm text-muted-foreground mt-1">Panel global de facturación y planes</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refrescar
        </Button>
      </div>

      {/* FILA 1 — KPIs */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20" /></CardContent></Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Planes activos"
            value={dashboard?.totalActivePlans ?? 0}
            icon={CreditCard}
            color="green"
          />
          <StatCard
            label="Pendientes de pago"
            value={dashboard?.totalPendingPayment ?? 0}
            icon={Clock}
            color="amber"
          />
          <StatCard
            label="Vencidos"
            value={dashboard?.totalExpired ?? 0}
            icon={AlertTriangle}
            color="red"
          />
          <StatCard
            label="Revenue mensual esperado"
            value={fmtMoney(dashboard?.expectedMonthlyRevenue ?? 0, 'USD')}
            icon={DollarSign}
            color="blue"
          />
        </div>
      )}

      {/* FILA 2 — Tablas lado a lado */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tabla A — Tenants próximos al límite */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Próximos al límite (&gt;80% de uso)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="px-4 py-3 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : !dashboard?.tenantsNearLimit.length ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                Sin tenants próximos al límite
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {['Tenant', 'Plan', 'Uso'].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dashboard.tenantsNearLimit.map((t) => (
                    <tr
                      key={t.tenantId}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                      onClick={() => router.push(`/tenants/${t.tenantId}`)}
                    >
                      <td className="px-4 py-2 font-medium">{t.name}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">{t.planCode}</Badge>
                      </td>
                      <td className="px-4 py-2 min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <Progress
                            value={t.percentage}
                            className="h-1.5 flex-1"
                            indicatorClassName={t.percentage >= 100 ? 'bg-destructive' : 'bg-amber-500'}
                          />
                          <span className={`text-xs font-medium ${t.percentage >= 100 ? 'text-destructive' : 'text-amber-600'}`}>
                            {t.percentage}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Tabla B — Próximos a vencer */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              Próximos a vencer (&lt;7 días)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="px-4 py-3 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : !dashboard?.expiringSoon.length ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                Sin planes próximos a vencer
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {['Tenant', 'Plan', 'Vence', 'Días'].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dashboard.expiringSoon.map((t) => (
                    <tr
                      key={t.tenantId}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                      onClick={() => router.push(`/tenants/${t.tenantId}`)}
                    >
                      <td className="px-4 py-2 font-medium">{t.name}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">{t.planCode}</Badge>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDate(t.expiresAt)}</td>
                      <td className="px-4 py-2">
                        <Badge variant={t.daysLeft <= 2 ? 'destructive' : 'warning'} className="text-xs">
                          {t.daysLeft}d
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* FILA 3 — Resumen de planes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Catálogo de planes
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Tier', 'Precio/mes', 'Facturas incluidas', 'Tenants activos', 'Revenue'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const activeCount = dashboard?.tenantsNearLimit.filter(
                    (t) => t.planCode === p.code,
                  ).length ?? 0;
                  // Active count from near-limit is a subset; we don't have total active per plan
                  // from the dashboard endpoint. Show what we have.
                  const revenue = Number(p.monthlyFee) * (dashboard?.totalActivePlans ?? 0);
                  void revenue; // revenue per-plan not available from dashboard; show per-plan price only
                  return (
                    <tr key={p.code} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <span className="font-mono font-medium text-xs">{p.code}</span>
                        <span className="text-muted-foreground text-xs ml-2">{p.name}</span>
                      </td>
                      <td className="px-4 py-3 font-medium">{fmtMoney(p.monthlyFee, 'USD')}</td>
                      <td className="px-4 py-3 text-muted-foreground">{p.includedInvoices.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center">
                        {activeCount > 0 ? (
                          <Badge variant="secondary">{activeCount}+</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        Ver historial en cada tenant
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
