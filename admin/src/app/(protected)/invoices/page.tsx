'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Filter } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtMoney, fmtNumber } from '@/lib/utils';
import type { Invoice, Paginated, InvoiceStatus, EcfType } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

interface InvoicesResponse extends Paginated<Invoice> {
  aggregations: { totalAmount: number; totalItbis: number; countByStatus: Record<string, number> };
}

async function fetchInvoices(params: URLSearchParams) {
  const res = await apiClient.get<{ data: InvoicesResponse }>(`/admin/invoices?${params}`);
  return res.data.data;
}

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ACCEPTED: 'success', REJECTED: 'destructive', CONDITIONAL: 'warning',
  CONTINGENCY: 'warning', ERROR: 'destructive', VOIDED: 'secondary',
  QUEUED: 'info', PROCESSING: 'info', SENT: 'info', DRAFT: 'secondary',
};

const ECF_TYPES: EcfType[] = ['E31','E32','E33','E34','E41','E43','E44','E45','E46','E47'];
const STATUSES: InvoiceStatus[] = ['DRAFT','QUEUED','PROCESSING','ACCEPTED','REJECTED','CONDITIONAL','VOIDED','CONTINGENCY','ERROR'];

export default function InvoicesPage() {
  const [encf, setEncf] = useState('');
  const [status, setStatus] = useState('');
  const [ecfType, setEcfType] = useState('');
  const [buyerRnc, setBuyerRnc] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const limit = 25;

  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (encf) params.set('encf', encf);
  if (status) params.set('status', status);
  if (ecfType) params.set('ecfType', ecfType);
  if (buyerRnc) params.set('buyerRnc', buyerRnc);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'invoices', page, encf, status, ecfType, buyerRnc, dateFrom, dateTo],
    queryFn: () => fetchInvoices(params),
  });

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Facturas</h1>
        <p className="text-sm text-muted-foreground mt-1">Búsqueda global cross-tenant</p>
      </div>

      {/* Aggregations */}
      {data?.aggregations && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Total filtrado</p><p className="text-xl font-bold">{fmtNumber(data.total)}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Monto total</p><p className="text-xl font-bold">{fmtMoney(data.aggregations.totalAmount)}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">ITBIS total</p><p className="text-xl font-bold">{fmtMoney(data.aggregations.totalItbis)}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Aceptadas</p><p className="text-xl font-bold">{fmtNumber(data.aggregations.countByStatus.ACCEPTED)}</p></CardContent></Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-44">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="eNCF…" className="pl-9" value={encf} onChange={(e) => { setEncf(e.target.value); setPage(1); }} />
        </div>
        <Input placeholder="RNC comprador" className="w-36" value={buyerRnc} onChange={(e) => { setBuyerRnc(e.target.value); setPage(1); }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Todos los estados</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={ecfType} onChange={(e) => { setEcfType(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Todos los tipos</option>
          {ECF_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['eNCF', 'Empresa', 'Comprador', 'Tipo', 'Estado', 'Monto', 'Fecha', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b">
                        {Array.from({ length: 8 }).map((__, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  : data?.items.map((inv) => (
                      <tr key={inv.id} className="border-b hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs">{inv.encf ?? '—'}</td>
                        <td className="px-4 py-3 max-w-32 truncate">{inv.company?.businessName ?? inv.companyId.slice(0, 8)}</td>
                        <td className="px-4 py-3 max-w-32 truncate">{inv.buyerName ?? inv.buyerRnc ?? '—'}</td>
                        <td className="px-4 py-3"><Badge variant="outline">{inv.ecfType}</Badge></td>
                        <td className="px-4 py-3">
                          <Badge variant={(STATUS_BADGE[inv.status] ?? 'secondary') as 'secondary'}>
                            {inv.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-medium">{fmtMoney(inv.totalAmount, inv.currency)}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(inv.createdAt)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{inv.id.slice(0, 8)}</td>
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
    </div>
  );
}
