'use client';

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime, fmtMoney, fmtNumber } from '@/lib/utils';
import type { Invoice, InvoiceStatus, EcfType, Company } from '@/types/api';

// The tenant /invoices endpoint raw response body:
//   { success: true, data: Invoice[], meta: { total, page, limit, totalPages } }
// data and meta are siblings — meta is NOT nested inside data.
interface TenantInvoiceResponse {
  success: boolean;
  data: Invoice[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { InvoiceDetailDrawer } from '@/components/invoices/invoice-detail-drawer';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';
function toSelect(v: string) { return v || ALL; }
function fromSelect(v: string) { return v === ALL ? '' : v; }

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

async function fetchInvoices(params: URLSearchParams): Promise<TenantInvoiceResponse> {
  // res.data IS { success, data: Invoice[], meta: {...} } — return it whole
  const res = await apiClient.get<TenantInvoiceResponse>(`/invoices?${params}`);
  return res.data;
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
          {data ? `${fmtNumber(data.meta.total)} factura${data.meta.total !== 1 ? 's' : ''} encontrada${data.meta.total !== 1 ? 's' : ''}` : 'Cargando…'}
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
            <Select value={toSelect(companyId)} onValueChange={(v) => { setCompanyId(fromSelect(v)); resetPage(); }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL}>Todas las empresas</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.businessName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* Status */}
          <Select value={toSelect(status)} onValueChange={(v) => { setStatus(fromSelect(v)); resetPage(); }}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={ALL}>Todos los estados</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          {/* ECF type */}
          <Select value={toSelect(ecfType)} onValueChange={(v) => { setEcfType(fromSelect(v)); resetPage(); }}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={ALL}>Todos los tipos</SelectItem>
              {ECF_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
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
          <Select
            value={String(limit)}
            onValueChange={(v) => { setLimit(Number(v) as typeof LIMITS[number]); resetPage(); }}
          >
            <SelectTrigger className="w-36 ml-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {LIMITS.map((l) => <SelectItem key={l} value={String(l)}>{l} por página</SelectItem>)}
            </SelectContent>
          </Select>
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
                  : data?.data.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                          No se encontraron facturas{hasFilters ? ' con los filtros aplicados' : ''}.
                        </td>
                      </tr>
                    )
                  : data?.data.map((inv) => (
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
          {data && data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">
                Pág. {page} de {data.meta.totalPages} · {fmtNumber(data.meta.total)} facturas
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>
                  Anterior
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= data.meta.totalPages}>
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
