'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime, fmtMoney, fmtNumber } from '@/lib/utils';
import type { Invoice, Paginated, InvoiceStatus, EcfType, Company } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { InvoiceDetailDrawer } from '@/components/invoices/invoice-detail-drawer';

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ACCEPTED: 'success', REJECTED: 'destructive', CONDITIONAL: 'warning',
  CONTINGENCY: 'warning', ERROR: 'destructive', VOIDED: 'secondary',
  QUEUED: 'info', PROCESSING: 'info', SENT: 'info', DRAFT: 'secondary',
};

const ECF_TYPES: EcfType[] = ['E31','E32','E33','E34','E41','E43','E44','E45','E46','E47'];
const STATUSES: InvoiceStatus[] = [
  'DRAFT','QUEUED','PROCESSING','SENT','ACCEPTED','REJECTED','CONDITIONAL','VOIDED','CONTINGENCY','ERROR',
];
const LIMITS = [10, 25, 50, 100] as const;

// ── API ────────────────────────────────────────────────────────────────────────

async function fetchInvoices(params: URLSearchParams): Promise<Paginated<Invoice>> {
  const res = await apiClient.get<{ data: Paginated<Invoice> }>(`/invoices?${params}`);
  return res.data.data;
}

async function fetchCompanies(): Promise<Company[]> {
  const res = await apiClient.get<{ data: Company[] }>('/companies');
  return res.data.data;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const [encf, setEncf]       = useState('');
  const [companyId, setCompanyId] = useState('');
  const [status, setStatus]   = useState('');
  const [ecfType, setEcfType] = useState('');
  const [buyerRnc, setBuyerRnc] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]   = useState('');
  const [page, setPage]       = useState(1);
  const [limit, setLimit]     = useState<typeof LIMITS[number]>(25);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const resetPage = useCallback(() => setPage(1), []);

  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (encf)      params.set('encf', encf);
  if (companyId) params.set('companyId', companyId);
  if (status)    params.set('status', status);
  if (ecfType)   params.set('ecfType', ecfType);
  if (buyerRnc)  params.set('buyerRnc', buyerRnc);
  if (dateFrom)  params.set('dateFrom', dateFrom);
  if (dateTo)    params.set('dateTo', dateTo);

  const { data, isLoading } = useQuery({
    queryKey: ['my', 'invoices', page, limit, encf, companyId, status, ecfType, buyerRnc, dateFrom, dateTo],
    queryFn: () => fetchInvoices(params),
  });

  const { data: companies = [] } = useQuery({
    queryKey: ['my', 'companies'],
    queryFn: fetchCompanies,
    staleTime: 60_000,
  });

  const hasFilters = !!(encf || companyId || status || ecfType || buyerRnc || dateFrom || dateTo);

  function clearFilters() {
    setEncf(''); setCompanyId(''); setStatus(''); setEcfType('');
    setBuyerRnc(''); setDateFrom(''); setDateTo(''); setPage(1);
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">Mis Facturas</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {data ? `${fmtNumber(data.total)} factura${data.total !== 1 ? 's' : ''} encontrada${data.total !== 1 ? 's' : ''}` : 'Cargando…'}
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
          {/* e-NCF search */}
          <div className="relative flex-1 min-w-44">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="e-NCF…"
              className="pl-9"
              value={encf}
              onChange={(e) => { setEncf(e.target.value); resetPage(); }}
            />
          </div>
          {/* Buyer RNC */}
          <Input
            placeholder="RNC comprador"
            className="w-36"
            value={buyerRnc}
            onChange={(e) => { setBuyerRnc(e.target.value); resetPage(); }}
          />
          {/* Company */}
          {companies.length > 0 && (
            <select
              value={companyId}
              onChange={(e) => { setCompanyId(e.target.value); resetPage(); }}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Todas las empresas</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.businessName}</option>
              ))}
            </select>
          )}
          {/* Status */}
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); resetPage(); }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Todos los estados</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {/* ECF type */}
          <select
            value={ecfType}
            onChange={(e) => { setEcfType(e.target.value); resetPage(); }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Todos los tipos</option>
            {ECF_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* Date range + limit row */}
        <div className="flex flex-wrap gap-3 items-center">
          <Input
            type="date"
            className="w-40"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); resetPage(); }}
            title="Fecha inicio"
          />
          <span className="text-sm text-muted-foreground">–</span>
          <Input
            type="date"
            className="w-40"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); resetPage(); }}
            title="Fecha fin"
          />
          <select
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value) as typeof LIMITS[number]); resetPage(); }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm ml-auto"
          >
            {LIMITS.map((l) => <option key={l} value={l}>{l} por página</option>)}
          </select>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>Limpiar filtros</Button>
          )}
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['e-NCF', 'Empresa', 'Comprador', 'Tipo', 'Estado', 'Monto', 'Fecha'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="border-b">
                        {Array.from({ length: 7 }).map((__, j) => (
                          <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  : data?.items.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                          No se encontraron facturas{hasFilters ? ' con los filtros aplicados' : ''}.
                        </td>
                      </tr>
                    )
                  : data?.items.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => setSelectedId(inv.id)}
                      >
                        <td className="px-4 py-3 font-mono text-xs">{inv.encf ?? '—'}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {inv.company?.businessName ?? companies.find((c) => c.id === inv.companyId)?.businessName ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <p>{inv.buyerName ?? '—'}</p>
                          {inv.buyerRnc && <p className="text-muted-foreground font-mono">{inv.buyerRnc}</p>}
                        </td>
                        <td className="px-4 py-3"><Badge variant="outline">{inv.ecfType}</Badge></td>
                        <td className="px-4 py-3">
                          <Badge variant={(STATUS_BADGE[inv.status] ?? 'secondary') as 'secondary'}>
                            {inv.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(inv.totalAmount)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDateTime(inv.createdAt)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">
                Pág. {page} de {data.totalPages} · {fmtNumber(data.total)} facturas
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>
                  Anterior
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= data.totalPages}>
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoice detail drawer */}
      <InvoiceDetailDrawer
        invoiceId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
