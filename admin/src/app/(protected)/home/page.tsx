'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  FileText, Building2, TrendingUp, Shield, Key, Plus,
  AlertTriangle, Clock, XCircle, CheckCircle2,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtNumber, fmtDate } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import type { TenantUsage } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';

interface TenantStats {
  totalInvoices: number;
  totalCompanies: number;
  invoicesThisMonth: number;
}

async function fetchStats(): Promise<TenantStats> {
  const res = await apiClient.get<{ data: TenantStats }>('/tenants/me/stats');
  return res.data.data;
}

async function fetchUsage(): Promise<TenantUsage> {
  const res = await apiClient.get<{ data: TenantUsage }>('/tenants/me/usage');
  return res.data.data;
}

function StatCard({
  label, value, sub, icon: Icon, color = 'blue',
}: { label: string; value: string | number; sub?: string; icon: React.ElementType; color?: string }) {
  const colorMap: Record<string, string> = {
    blue:   'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    green:  'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
    amber:  'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
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

// ── usage card ─────────────────────────────────────────────────────────────────

function UsageCard({ usage, isLoading }: { usage: TenantUsage | undefined; isLoading: boolean }) {
  const router = useRouter();

  if (isLoading) {
    return <Card><CardContent className="pt-6"><Skeleton className="h-24" /></CardContent></Card>;
  }

  if (!usage) return null;

  // Super-admin: never show billing card
  if ('isExemptFromBilling' in usage && usage.isExemptFromBilling) return null;

  const typed = usage as Exclude<TenantUsage, { isExemptFromBilling: true }>;
  const { hasActivePlan, plan, usage: u, status } = typed;

  // NO_PLAN
  if (!hasActivePlan && status === 'NO_PLAN') {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
              <XCircle className="h-6 w-6 text-destructive" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-destructive">Sin plan activo</p>
              <p className="text-sm text-muted-foreground mt-1">
                No podés emitir facturas hasta que se te asigne un plan. Contactá al administrador del sistema.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // PENDING_PAYMENT
  if (!hasActivePlan && status === 'PENDING_PAYMENT' && plan) {
    return (
      <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30 shrink-0">
              <Clock className="h-6 w-6 text-amber-600" />
            </div>
            <div>
              <p className="font-semibold">Tu plan {plan.code} está pendiente de pago</p>
              <p className="text-sm text-muted-foreground mt-1">
                Realizá la transferencia y contactá al administrador para activar tu plan.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // EXPIRED
  if (!hasActivePlan && status === 'EXPIRED') {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <div>
              <p className="font-semibold text-destructive">Tu plan venció</p>
              {u?.periodEnd && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  El {fmtDate(u.periodEnd)}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                Contactá al administrador para renovar tu plan.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ACTIVE
  if (hasActivePlan && plan && u) {
    const nearLimit = u.percentage >= 80;
    const exceeded = u.percentage >= 100;
    const borderClass = exceeded
      ? 'border-destructive/50'
      : nearLimit
        ? 'border-amber-200 dark:border-amber-800'
        : 'border-green-200 dark:border-green-800';

    return (
      <Card className={borderClass}>
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className={`p-2 rounded-lg shrink-0 ${exceeded ? 'bg-destructive/10' : nearLimit ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-green-100 dark:bg-green-900/30'}`}>
              {exceeded ? (
                <XCircle className="h-6 w-6 text-destructive" />
              ) : nearLimit ? (
                <AlertTriangle className="h-6 w-6 text-amber-600" />
              ) : (
                <CheckCircle2 className="h-6 w-6 text-green-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{plan.name}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 shrink-0"
                  onClick={() => router.push('/settings?tab=plan')}
                >
                  Ver detalle
                </Button>
              </div>

              <div className="mt-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Facturas usadas</span>
                  <span className={exceeded ? 'text-destructive font-medium' : nearLimit ? 'text-amber-600 font-medium' : ''}>
                    {u.current.toLocaleString()} / {u.limit.toLocaleString()} ({u.percentage}%)
                  </span>
                </div>
                <Progress
                  value={u.percentage}
                  indicatorClassName={exceeded ? 'bg-destructive' : nearLimit ? 'bg-amber-500' : 'bg-green-500'}
                />
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{u.remaining.toLocaleString()} facturas restantes</span>
                <span className={u.daysRemaining <= 7 ? 'text-amber-600 font-medium' : ''}>
                  Vence en {u.daysRemaining} días ({fmtDate(u.periodEnd)})
                </span>
              </div>

              {(exceeded || nearLimit) && (
                <p className={`text-xs mt-2 flex items-center gap-1 ${exceeded ? 'text-destructive' : 'text-amber-600'}`}>
                  <AlertTriangle className="h-3 w-3" />
                  {exceeded
                    ? 'Has alcanzado el límite de tu plan. No podés emitir más facturas.'
                    : 'Cerca del límite. Contactá al admin para renovar o actualizar.'}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  const { tenant } = useAuth();

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['my', 'stats'],
    queryFn: fetchStats,
  });

  const { data: usageData, isLoading: usageLoading } = useQuery({
    queryKey: ['my', 'usage'],
    queryFn: fetchUsage,
  });

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Bienvenido{tenant?.name ? `, ${tenant.name}` : ''}</h1>
        <p className="text-sm text-muted-foreground mt-1">Resumen de tu cuenta</p>
      </div>

      {/* Plan usage card (above KPIs) */}
      <UsageCard usage={usageData} isLoading={usageLoading} />

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statsLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20" /></CardContent></Card>
          ))
        ) : (
          <>
            <StatCard
              label="Facturas totales"
              value={statsData?.totalInvoices ?? 0}
              icon={FileText}
              color="blue"
            />
            <StatCard
              label="Facturas este mes"
              value={statsData?.invoicesThisMonth ?? 0}
              icon={TrendingUp}
              color="green"
            />
            <StatCard
              label="Empresas registradas"
              value={statsData?.totalCompanies ?? 0}
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
        Accedé a{' '}
        <button className="underline text-foreground" onClick={() => router.push('/invoices')}>
          Mis Facturas
        </button>{' '}
        para ver el historial completo con filtros.
      </p>

    </div>
  );
}
