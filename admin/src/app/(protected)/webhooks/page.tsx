'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime, fmtNumber } from '@/lib/utils';
import type { WebhookDelivery, Paginated } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

async function fetchDeliveries(page: number, onlyFailed: boolean) {
  const params = new URLSearchParams({ page: String(page), limit: '25' });
  if (onlyFailed) params.set('onlyFailed', 'true');
  const res = await apiClient.get<{ data: Paginated<WebhookDelivery> }>(`/admin/webhooks/deliveries?${params}`);
  return res.data.data;
}

async function retryDelivery(id: string) {
  const res = await apiClient.post(`/admin/webhooks/deliveries/${id}/retry`);
  return res.data;
}

function statusCodeBadge(code: number | null | undefined) {
  if (!code) return <Badge variant="secondary">Pending</Badge>;
  if (code >= 200 && code < 300) return <Badge variant="success">{code}</Badge>;
  return <Badge variant="destructive">{code}</Badge>;
}

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'webhook-deliveries', page, onlyFailed],
    queryFn: () => fetchDeliveries(page, onlyFailed),
  });

  const retryMut = useMutation({
    mutationFn: retryDelivery,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'webhook-deliveries'] });
      setSelected(null);
    },
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Webhook Deliveries</h1>
          <p className="text-sm text-muted-foreground mt-1">{data ? `${fmtNumber(data.total)} entregas` : 'Cargando…'}</p>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => { setOnlyFailed(e.target.checked); setPage(1); }} className="rounded" />
          Solo fallidas
        </label>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['URL', 'Evento', 'Status', 'Intentos', 'Entregado', 'Creado', 'Acciones'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b">
                        {Array.from({ length: 7 }).map((__, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>)}
                      </tr>
                    ))
                  : data?.items.map((d) => (
                      <tr key={d.id} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-3 max-w-40 truncate text-xs font-mono">{d.url ?? '—'}</td>
                        <td className="px-4 py-3"><Badge variant="outline">{d.event}</Badge></td>
                        <td className="px-4 py-3">{statusCodeBadge(d.statusCode)}</td>
                        <td className="px-4 py-3 text-center">{d.attempts}/{d.maxAttempts}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{d.deliveredAt ? fmtDateTime(d.deliveredAt) : '—'}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDateTime(d.createdAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(d)}>Ver</Button>
                            {d.attempts >= d.maxAttempts && !d.deliveredAt && (
                              <Button
                                variant="outline" size="sm" className="h-7 text-xs gap-1"
                                onClick={() => retryMut.mutate(d.id)}
                                disabled={retryMut.isPending}
                              >
                                <RefreshCw className="h-3 w-3" /> Retry
                              </Button>
                            )}
                          </div>
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

      {/* Delivery detail modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-background border rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-lg">Delivery: {selected.id.slice(0, 8)}…</h2>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</Button>
            </div>
            <div className="space-y-3 text-sm">
              <div><span className="font-medium">Evento:</span> {selected.event}</div>
              <div><span className="font-medium">URL:</span> <span className="font-mono text-xs">{selected.url}</span></div>
              <div><span className="font-medium">Status:</span> {selected.statusCode ?? 'Sin respuesta'}</div>
              <div><span className="font-medium">Intentos:</span> {selected.attempts}/{selected.maxAttempts}</div>
              <div>
                <p className="font-medium mb-1">Payload:</p>
                <pre className="bg-muted rounded p-3 text-xs overflow-auto max-h-40">{selected.payload}</pre>
              </div>
              {selected.responseBody && (
                <div>
                  <p className="font-medium mb-1">Response:</p>
                  <pre className="bg-muted rounded p-3 text-xs overflow-auto max-h-32">{selected.responseBody}</pre>
                </div>
              )}
              {selected.attempts >= selected.maxAttempts && !selected.deliveredAt && (
                <Button onClick={() => retryMut.mutate(selected.id)} disabled={retryMut.isPending} className="w-full gap-2">
                  <RefreshCw className="h-4 w-4" />
                  {retryMut.isPending ? 'Re-encolando…' : 'Forzar reintento'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
