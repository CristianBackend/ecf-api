'use client';

import { useRef, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle, XCircle, AlertTriangle, Activity, Clock } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtUptime, fmtBytes, fmtDateTime, fmtNumber } from '@/lib/utils';
import type { AdminHealth } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

async function fetchHealth(): Promise<AdminHealth> {
  const res = await apiClient.get<{ data: AdminHealth }>('/admin/health');
  return res.data.data;
}

type HistoryPoint = { time: string; dbMs: number; redisMs: number };

function StatusBadge({ status }: { status: string }) {
  const variants = { healthy: 'success', degraded: 'warning', unhealthy: 'destructive', ok: 'success', error: 'destructive' };
  const icons = { healthy: CheckCircle, degraded: AlertTriangle, unhealthy: XCircle, ok: CheckCircle, error: XCircle };
  const Icon = icons[status as keyof typeof icons] ?? Activity;
  return (
    <Badge variant={(variants[status as keyof typeof variants] ?? 'secondary') as 'secondary'} className="gap-1">
      <Icon className="h-3 w-3" /> {status}
    </Badge>
  );
}

export default function HealthPage() {
  const historyRef = useRef<HistoryPoint[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!data) return;
    const point: HistoryPoint = {
      time: new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      dbMs: data.checks.database.responseTimeMs,
      redisMs: data.checks.redis.responseTimeMs,
    };
    historyRef.current = [...historyRef.current.slice(-59), point];
    setHistory([...historyRef.current]);
  }, [data]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Salud del Sistema</h1>
          <p className="text-sm text-muted-foreground mt-1">Monitoreo en tiempo real · Refresh cada 10s</p>
        </div>
        {data && <StatusBadge status={data.status} />}
      </div>

      {/* Core checks */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {isLoading ? (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">Base de Datos</span>
                  {data && <StatusBadge status={data.checks.database.status} />}
                </div>
                <p className="text-3xl font-bold">{data?.checks.database.responseTimeMs ?? '—'}<span className="text-base font-normal text-muted-foreground"> ms</span></p>
                {data?.checks.database.error && <p className="text-xs text-destructive mt-1 truncate">{data.checks.database.error}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">Redis</span>
                  {data && <StatusBadge status={data.checks.redis.status} />}
                </div>
                <p className="text-3xl font-bold">{data?.checks.redis.responseTimeMs ?? '—'}<span className="text-base font-normal text-muted-foreground"> ms</span></p>
                {data?.checks.redis.error && <p className="text-xs text-destructive mt-1 truncate">{data.checks.redis.error}</p>}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Response time history */}
      <Card>
        <CardHeader><CardTitle className="text-base flex gap-2"><Activity className="h-5 w-5" /> Latencia (últimos 60 puntos)</CardTitle></CardHeader>
        <CardContent>
          {history.length < 2 ? (
            <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">Recopilando datos…</div>
          ) : (
            <ResponsiveContainer width="100%" height={128}>
              <LineChart data={history} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} unit="ms" />
                <Tooltip formatter={(v) => `${Number(v)}ms`} />
                <Line type="monotone" dataKey="dbMs" name="DB" stroke="#3b82f6" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="redisMs" name="Redis" stroke="#22c55e" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Queues */}
      {data?.checks.queues && (
        <Card>
          <CardHeader><CardTitle className="text-base">Colas BullMQ</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(data.checks.queues).map(([name, stats]) => (
                <div key={name} className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{name}</p>
                  <div className="grid grid-cols-3 gap-1 text-xs text-center">
                    <div><p className="font-semibold text-yellow-600">{fmtNumber(stats.waiting)}</p><p className="text-muted-foreground">Esp.</p></div>
                    <div><p className="font-semibold text-blue-600">{fmtNumber(stats.active)}</p><p className="text-muted-foreground">Act.</p></div>
                    <div><p className={`font-semibold ${stats.failed > 0 ? 'text-red-600' : ''}`}>{fmtNumber(stats.failed)}</p><p className="text-muted-foreground">Fall.</p></div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Scheduler */}
      {data?.checks.scheduler && (
        <Card>
          <CardHeader><CardTitle className="text-base flex gap-2"><Clock className="h-5 w-5" /> Scheduler — Último Run</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              {[
                ['Contingency Retry', data.checks.scheduler.lastContingencyRun],
                ['Token Cleanup', data.checks.scheduler.lastTokenCleanup],
                ['Certificate Check', data.checks.scheduler.lastCertificateCheck],
              ].map(([label, ts]) => (
                <div key={String(label)} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium mt-1">{ts ? fmtDateTime(String(ts)) : <span className="text-muted-foreground text-xs">Nunca (desde último deploy)</span>}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}

      {/* System info */}
      {data?.checks.system && (
        <Card>
          <CardHeader><CardTitle className="text-base">Sistema</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              {[
                ['Versión', data.checks.system.version],
                ['Uptime', fmtUptime(data.checks.system.uptime)],
                ['Entorno', data.checks.system.nodeEnv],
                ['Heap usado', fmtBytes(data.checks.system.memoryUsage.heapUsed)],
                ['Heap total', fmtBytes(data.checks.system.memoryUsage.heapTotal)],
                ['RSS', fmtBytes(data.checks.system.memoryUsage.rss)],
              ].map(([label, val]) => (
                <div key={String(label)} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-semibold mt-1">{val}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
