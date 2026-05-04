'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Download, RefreshCw, X, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/utils';
import type { Invoice, InvoiceStatus } from '@/types/api';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ACCEPTED: 'success', REJECTED: 'destructive', CONDITIONAL: 'warning',
  CONTINGENCY: 'warning', ERROR: 'destructive', VOIDED: 'secondary',
  QUEUED: 'info', PROCESSING: 'info', SENT: 'info', DRAFT: 'secondary',
};

const ECF_LABELS: Record<string, string> = {
  E31: 'Crédito Fiscal', E32: 'Consumo', E33: 'Nota Débito', E34: 'Nota Crédito',
  E41: 'Compras', E43: 'Gastos Menores', E44: 'Regímenes Especiales',
  E45: 'Gubernamental', E46: 'Exportaciones', E47: 'Pagos al Exterior',
};

interface InvoiceDetail extends Omit<Invoice, 'totalItbis'> {
  totalItbis?: number;
  dgiiResponse?: { code: number; message: string } | null;
  signedAt?: string;
  acceptedAt?: string;
}

interface Props {
  invoiceId: string | null;
  onClose: () => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

export function InvoiceDetailDrawer({ invoiceId, onClose }: Props) {
  const [xmlContent, setXmlContent] = useState<string | null>(null);
  const [xmlLoading, setXmlLoading] = useState(false);

  const { data: invoice, isLoading } = useQuery<InvoiceDetail>({
    queryKey: ['my', 'invoice', invoiceId],
    queryFn: async () => {
      const res = await apiClient.get<{ data: InvoiceDetail }>(`/invoices/${invoiceId}`);
      return res.data.data;
    },
    enabled: !!invoiceId,
  });

  async function loadXml() {
    if (xmlContent || !invoiceId) return;
    setXmlLoading(true);
    try {
      const res = await apiClient.get<string>(`/invoices/${invoiceId}/xml`, {
        responseType: 'text',
      });
      setXmlContent(res.data);
    } catch {
      toast.error('No se pudo cargar el XML');
    } finally {
      setXmlLoading(false);
    }
  }

  async function downloadXml() {
    if (!invoiceId || !invoice) return;
    try {
      // Get a single-use token for browser download
      const tkRes = await apiClient.post<{ data: { token: string } }>(`/invoices/${invoiceId}/download-token`);
      const token = tkRes.data.data.token;
      window.open(`${API_BASE}/downloads/invoice-xml/${token}`, '_blank');
    } catch {
      toast.error('Error al generar enlace de descarga');
    }
  }

  async function pollStatus() {
    if (!invoiceId) return;
    try {
      await apiClient.post(`/invoices/${invoiceId}/poll`);
      toast.success('Estado actualizado desde DGII');
    } catch {
      toast.error('Error al consultar DGII');
    }
  }

  const canPoll = invoice && ['PROCESSING', 'CONTINGENCY', 'QUEUED', 'SENT'].includes(invoice.status);

  return (
    <Sheet open={!!invoiceId} onOpenChange={(open) => { if (!open) { onClose(); setXmlContent(null); } }}>
      <SheetContent side="right" className="flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b p-4 shrink-0">
          {isLoading ? (
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
          ) : invoice ? (
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold text-base">{invoice.encf ?? invoice.id.slice(0, 8)}</span>
                <Badge variant={(STATUS_BADGE[invoice.status] ?? 'secondary') as 'secondary'}>
                  {invoice.status}
                </Badge>
                <Badge variant="outline">{ECF_LABELS[invoice.ecfType] ?? invoice.ecfType}</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {fmtDateTime(invoice.createdAt)}
              </p>
            </div>
          ) : null}
          <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => { onClose(); setXmlContent(null); }}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-4" />)}
            </div>
          ) : invoice ? (
            <Tabs defaultValue="datos" className="h-full flex flex-col">
              <TabsList className="mx-4 mt-3 shrink-0">
                <TabsTrigger value="datos">Datos</TabsTrigger>
                <TabsTrigger value="xml" onClick={loadXml}>XML</TabsTrigger>
                <TabsTrigger value="pdf">PDF</TabsTrigger>
              </TabsList>

              {/* Tab: Datos */}
              <TabsContent value="datos" className="flex-1 overflow-y-auto px-4 pb-4 mt-3">
                <div className="space-y-4 text-sm">
                  <Section title="Factura">
                    <Row label="e-NCF" value={invoice.encf ?? '—'} mono />
                    <Row label="Tipo" value={`${invoice.ecfType} — ${ECF_LABELS[invoice.ecfType] ?? ''}`} />
                    <Row label="Estado" value={<Badge variant={(STATUS_BADGE[invoice.status] ?? 'secondary') as 'secondary'}>{invoice.status}</Badge>} />
                    <Row label="Fecha emisión" value={fmtDateTime(invoice.createdAt)} />
                    {invoice.acceptedAt && <Row label="Fecha aceptación" value={fmtDateTime(invoice.acceptedAt)} />}
                  </Section>

                  <Section title="Montos">
                    <Row label="Subtotal" value={fmtMoney(invoice.subtotal)} />
                    <Row label="ITBIS" value={fmtMoney(invoice.totalItbis)} />
                    <Row label="Descuento" value={fmtMoney(invoice.totalDiscount)} />
                    <Row label="Total" value={<span className="font-bold">{fmtMoney(invoice.totalAmount)}</span>} />
                    <Row label="Moneda" value={`${invoice.currency}${invoice.exchangeRate ? ` (TC: ${invoice.exchangeRate})` : ''}`} />
                  </Section>

                  {(invoice.buyerRnc || invoice.buyerName) && (
                    <Section title="Comprador">
                      {invoice.buyerRnc && <Row label="RNC" value={invoice.buyerRnc} mono />}
                      {invoice.buyerName && <Row label="Nombre" value={invoice.buyerName} />}
                    </Section>
                  )}

                  {(invoice.trackId || invoice.dgiiResponse) && (
                    <Section title="DGII">
                      {invoice.trackId && <Row label="Track ID" value={invoice.trackId} mono />}
                      {invoice.dgiiResponse && (
                        <Row
                          label="Respuesta"
                          value={`${invoice.dgiiResponse.code} — ${invoice.dgiiResponse.message}`}
                        />
                      )}
                    </Section>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap gap-2 pt-2">
                    {canPoll && (
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={pollStatus}>
                        <RefreshCw className="h-3.5 w-3.5" /> Consultar DGII
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={downloadXml}>
                      <Download className="h-3.5 w-3.5" /> Descargar XML
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => window.open(`${API_BASE}/invoices/${invoiceId}/pdf`, '_blank')}
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Ver PDF
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* Tab: XML */}
              <TabsContent value="xml" className="flex-1 overflow-hidden px-4 pb-4 mt-3">
                {xmlLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : xmlContent ? (
                  <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-auto h-full whitespace-pre-wrap break-all">
                    {xmlContent}
                  </pre>
                ) : (
                  <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
                    <p>XML no disponible todavía</p>
                  </div>
                )}
              </TabsContent>

              {/* Tab: PDF */}
              <TabsContent value="pdf" className="flex-1 overflow-hidden px-4 pb-4 mt-3">
                <iframe
                  src={`${API_BASE}/invoices/${invoiceId}/pdf`}
                  className="w-full h-full rounded-md border"
                  title="PDF de factura"
                />
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('text-right', mono ? 'font-mono text-xs' : '')}>{value}</span>
    </div>
  );
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(' ');
}
