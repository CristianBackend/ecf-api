'use client';

import { useMetrics } from '@/hooks/use-metrics';
import { fmtNumber, fmtUptime, fmtMoney } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Users, FileText, Building2, Shield, Webhook, AlertTriangle, CheckCircle,
  TrendingUp, Activity,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const STATUS_COLORS: Record<string, string> = {
  ACCEPTED: '#22c55e', REJECTED: '#ef4444', CONDITIONAL: '#f59e0b',
  CONTINGENCY: '#f97316', ERROR: '#dc2626', VOIDED: '#6b7280',
  QUEUED: '#3b82f6', PROCESSING: '#8b5cf6', DRAFT: '#94a3b8',
};

const ECF_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#14b8a6', '#f97316', '#ef4444', '#06b6d4', '#84cc16'];

function KpiCard({
  title, value, sub, icon: Icon, color = 'blue',
}: { title: string; value: string; sub?: string; icon: React.ElementType; color?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl bg-${color}-100 dark:bg-${color}-900/30`}>
            <Icon className={`h-6 w-6 text-${color}-600 dark:text-${color}-400`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KpiSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-12 w-12 rounded-xl" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error } = useMetrics();

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-muted-foreground">Error cargando métricas. Verificá la conexión al backend.</p>
      </div>
    );
  }

  const invoices = data?.invoices;
  const acceptedCount = invoices?.byStatus?.ACCEPTED ?? 0;
  const totalInvoices = invoices?.total ?? 0;
  const acceptanceRate = totalInvoices > 0 ? Math.round((acceptedCount / totalInvoices) * 100) : 0;

  const statusPieData = invoices
    ? Object.entries(invoices.byStatus).map(([name, value]) => ({ name, value }))
    : [];

  const ecfBarData = invoices
    ? Object.entries(invoices.byEcfType).map(([name, value]) => ({ name, value }))
    : [];

  const failedQueues = data
    ? Object.entries(data.queues).filter(([, s]) => s.failed > 0)
    : [];

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Vista global del sistema.{' '}
          {data?.system && (
            <span>Uptime: {fmtUptime(data.system.uptime)} · v{data.system.version} · {data.system.dgiiEnvironment}</span>
          )}
        </p>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)
        ) : (
          <>
            <KpiCard
              title="Tenants activos"
              value={fmtNumber(data?.tenants.active)}
              sub={`+${data?.tenants.newThisMonth ?? 0} este mes · ${fmtNumber(data?.tenants.total)} total`}
              icon={Users}
              color="blue"
            />
            <KpiCard
              title="Facturas hoy"
              value={fmtNumber(invoices?.today)}
              sub={`${fmtNumber(invoices?.thisMonth)} este mes`}
              icon={FileText}
              color="violet"
            />
            <KpiCard
              title="Tasa de aceptación"
              value={`${acceptanceRate}%`}
              sub={`${fmtNumber(acceptedCount)} aceptadas de ${fmtNumber(totalInvoices)}`}
              icon={TrendingUp}
              color="green"
            />
            <KpiCard
              title="Certificados activos"
              value={fmtNumber(data?.certificates.active)}
              sub={`${data?.certificates.expiringSoon ?? 0} vencen en <30 días`}
              icon={Shield}
              color={data?.certificates.expiringSoon ? 'yellow' : 'emerald'}
            />
          </>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Status Pie */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Facturas por Estado</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : statusPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie dataKey="value" data={statusPieData} cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                    {statusPieData.map((entry, i) => (
                      <Cell key={i} fill={STATUS_COLORS[entry.name] ?? '#64748b'} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => fmtNumber(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">Sin datos</div>
            )}
          </CardContent>
        </Card>

        {/* ECF Type Bar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Facturas por Tipo e-CF</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : ecfBarData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={ecfBarData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => fmtNumber(Number(v))} />
                  <Bar dataKey="value" name="Facturas" radius={[4, 4, 0, 0]}>
                    {ecfBarData.map((_, i) => <Cell key={i} fill={ECF_COLORS[i % ECF_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">Sin datos</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Alerts section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-5 w-5" /> Alertas del Sistema
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : (
            <div className="space-y-2">
              {data?.certificates.expiringSoon ? (
                <div className="flex items-center gap-2 rounded-md bg-yellow-50 dark:bg-yellow-900/20 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {data.certificates.expiringSoon} certificado(s) vencen en menos de 30 días
                </div>
              ) : null}

              {data?.certificates.expired ? (
                <div className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {data.certificates.expired} certificado(s) vencidos
                </div>
              ) : null}

              {data?.webhooks.failedToday ? (
                <div className="flex items-center gap-2 rounded-md bg-orange-50 dark:bg-orange-900/20 px-3 py-2 text-sm text-orange-800 dark:text-orange-300 border border-orange-200 dark:border-orange-800">
                  <Webhook className="h-4 w-4 shrink-0" />
                  {data.webhooks.failedToday} entrega(s) de webhook fallaron hoy
                </div>
              ) : null}

              {failedQueues.map(([queue, stats]) => (
                <div key={queue} className="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Cola {queue}: {stats.failed} job(s) fallidos
                </div>
              ))}

              {!data?.certificates.expiringSoon && !data?.certificates.expired &&
               !data?.webhooks.failedToday && failedQueues.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  Sin alertas activas. El sistema opera normalmente.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Queues summary */}
      {data?.queues && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estado de Colas BullMQ</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(data.queues).map(([name, stats]) => (
                <div key={name} className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">{name}</p>
                  <div className="grid grid-cols-3 gap-1 text-xs">
                    {[
                      ['Esperando', stats.waiting, 'text-yellow-600'],
                      ['Activos', stats.active, 'text-blue-600'],
                      ['Fallidos', stats.failed, stats.failed > 0 ? 'text-red-600 font-bold' : ''],
                    ].map(([label, val, cls]) => (
                      <div key={String(label)} className="text-center">
                        <p className={`font-semibold ${cls}`}>{fmtNumber(Number(val))}</p>
                        <p className="text-muted-foreground">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
