'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/utils';
import type { AuditLog, Paginated } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

async function fetchAuditLogs(page: number, entityType: string, action: string, dateFrom: string, dateTo: string) {
  const params = new URLSearchParams({ page: String(page), limit: '50' });
  if (entityType) params.set('entityType', entityType);
  if (action) params.set('action', action);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const res = await apiClient.get<{ data: Paginated<AuditLog> }>(`/admin/audit-logs?${params}`);
  return res.data.data;
}

const ACTION_BADGE: Record<string, string> = {
  queued: 'info', accepted: 'success', rejected: 'destructive',
  created: 'default', updated: 'secondary', voided: 'warning',
};

export default function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit-logs', page, entityType, action, dateFrom, dateTo],
    queryFn: () => fetchAuditLogs(page, entityType, action, dateFrom, dateTo),
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground mt-1">{data ? `${data.total.toLocaleString()} eventos` : 'Cargando…'}</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Todos los tipos</option>
          {['invoice', 'company', 'certificate', 'tenant', 'apikey', 'webhook'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Todas las acciones</option>
          {['queued', 'created', 'updated', 'voided', 'accepted', 'rejected', 'signed', 'status_updated'].map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Timestamp', 'Tenant', 'Tipo', 'Entity ID', 'Acción', 'Actor', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b">
                        {Array.from({ length: 7 }).map((__, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}
                      </tr>
                    ))
                  : data?.items.map((log) => (
                      <tr key={log.id} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(log.createdAt)}</td>
                        <td className="px-4 py-3 text-xs max-w-32 truncate">{log.tenant?.name ?? log.tenantId.slice(0, 8)}</td>
                        <td className="px-4 py-3"><Badge variant="outline">{log.entityType}</Badge></td>
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{log.entityId.slice(0, 8)}…</td>
                        <td className="px-4 py-3">
                          <Badge variant={(ACTION_BADGE[log.action] ?? 'secondary') as 'secondary'}>{log.action}</Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{log.actor ?? '—'}</td>
                        <td className="px-4 py-3">
                          {log.metadata && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(log)}>Ver</Button>
                          )}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">Pág. {page} de {data.totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>Anterior</Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= data.totalPages}>Siguiente</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-background border rounded-xl shadow-xl max-w-lg w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold">Metadata del log</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</Button>
            </div>
            <pre className="bg-muted rounded p-3 text-xs overflow-auto max-h-96">
              {JSON.stringify(selected.metadata, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
