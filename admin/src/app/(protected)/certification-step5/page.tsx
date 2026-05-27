'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  FileText, Download, Loader2, CheckCircle2, AlertCircle,
  FileDown, Eye, Trash2, Package,
} from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { apiClient } from '@/lib/api-client';
import type { Company } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// ============================================================================
// Types
// ============================================================================

interface InvoiceListItem {
  id: string;
  ecfType: string;
  encf: string;
  status: string;
  totalAmount: string | number;
  isRfce?: boolean;
  signedAt?: string | null;
  createdAt: string;
}

interface SlotState {
  pdf: Blob | null;
  pdfSize: number;
  isGenerating: boolean;
  error: string | null;
}

interface SlotDef {
  slotId: string;
  typeCode: string;
  label: string;
  isRfce: boolean;
}

// ============================================================================
// DGII Paso 5 — 11 required PDF slots (stable constant, NEVER recreated)
// ============================================================================

const REQUIRED_SLOTS: SlotDef[] = [
  { slotId: 'E31',        typeCode: '31', label: 'Factura de Crédito Fiscal Electrónica',         isRfce: false },
  { slotId: 'E32-grande', typeCode: '32', label: 'Factura de Consumo Electrónica ≥ RD$250mil',    isRfce: false },
  { slotId: 'E33',        typeCode: '33', label: 'Nota de Débito Electrónica',                    isRfce: false },
  { slotId: 'E34',        typeCode: '34', label: 'Nota de Crédito Electrónica',                   isRfce: false },
  { slotId: 'E41',        typeCode: '41', label: 'Comprobante Electrónico de Compras',            isRfce: false },
  { slotId: 'E43',        typeCode: '43', label: 'Comprobante Electrónico para Gastos Menores',   isRfce: false },
  { slotId: 'E44',        typeCode: '44', label: 'Comprobante Electrónico para Regímenes Especiales', isRfce: false },
  { slotId: 'E45',        typeCode: '45', label: 'Comprobante Electrónico Gubernamental',         isRfce: false },
  { slotId: 'E46',        typeCode: '46', label: 'Comprobante Electrónico para Exportaciones',    isRfce: false },
  { slotId: 'E47',        typeCode: '47', label: 'Comprobante Electrónico para Pagos al Exterior', isRfce: false },
  { slotId: 'E32-rfce',   typeCode: '32', label: 'Factura de Consumo Electrónica < RD$250mil (RFCE)', isRfce: true },
];

const INITIAL_SLOT_STATE: SlotState = {
  pdf: null,
  pdfSize: 0,
  isGenerating: false,
  error: null,
};

const MAX_TOTAL_SIZE_MB = 10;

// ============================================================================
// API calls
// ============================================================================

async function fetchCompanies(): Promise<Company[]> {
  const res = await apiClient.get<{ data: Company[] }>('/companies');
  return res.data.data;
}

async function fetchAcceptedInvoices(companyId: string): Promise<InvoiceListItem[]> {
  const res = await apiClient.get<{ data: InvoiceListItem[] | { items: InvoiceListItem[] } }>('/invoices', {
    params: { companyId, status: 'ACCEPTED', limit: 100 },
  });
  const raw = res.data.data;
  if (Array.isArray(raw)) return raw;
  if (raw && 'items' in raw) return raw.items;
  return [];
}

async function downloadPdf(invoiceId: string): Promise<Blob> {
  const res = await apiClient.get(
    `/representacion-impresa/invoice/${invoiceId}/pdf`,
    { responseType: 'blob' },
  );
  return res.data as Blob;
}

// ============================================================================
// Helpers
// ============================================================================

function bytesToMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getErrorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: { message?: string }; message?: string } };
    message?: string;
  };
  return (
    e.response?.data?.error?.message ??
    e.response?.data?.message ??
    e.message ??
    'Error generando el PDF'
  );
}

function pickInvoiceForSlot(
  slot: SlotDef,
  invoices: InvoiceListItem[],
): InvoiceListItem | null {
  const matching = invoices
    .filter((inv) => {
      const code = inv.ecfType.replace(/^E/, '');
      if (code !== slot.typeCode) return false;
      if (slot.typeCode === '32') {
        return Boolean(inv.isRfce) === slot.isRfce;
      }
      return true;
    })
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  return matching[0] ?? null;
}

// ============================================================================
// Page
// ============================================================================

export default function CertificationStep5Page() {
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  // State map: slotId → SlotState (only generation state, NOT invoice mapping)
  const [slotStates, setSlotStates] = useState<Record<string, SlotState>>(() => {
    const init: Record<string, SlotState> = {};
    for (const s of REQUIRED_SLOTS) init[s.slotId] = { ...INITIAL_SLOT_STATE };
    return init;
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // 1. Companies
  const { data: companies = [], isLoading: companiesLoading } = useQuery({
    queryKey: ['my', 'companies'],
    queryFn: fetchCompanies,
  });
  const certCompanies = useMemo(
    () => companies.filter((c) => c.dgiiEnv === 'CERT'),
    [companies],
  );

  // 2. Invoices for selected company
  const { data: invoices = [], isLoading: invoicesLoading } = useQuery({
    queryKey: ['step5', 'invoices', selectedCompanyId],
    queryFn: () => fetchAcceptedInvoices(selectedCompanyId),
    enabled: !!selectedCompanyId,
  });

  // 3. Derive invoice-per-slot mapping (pure, no setState)
  const slots = useMemo(() => {
    return REQUIRED_SLOTS.map((slot) => ({
      ...slot,
      invoice: invoices.length ? pickInvoiceForSlot(slot, invoices) : null,
      state: slotStates[slot.slotId] ?? INITIAL_SLOT_STATE,
    }));
  }, [invoices, slotStates]);

  // 4. Reset slot states when company changes
  useEffect(() => {
    const reset: Record<string, SlotState> = {};
    for (const s of REQUIRED_SLOTS) reset[s.slotId] = { ...INITIAL_SLOT_STATE };
    setSlotStates(reset);
  }, [selectedCompanyId]);

  const updateSlotState = (slotId: string, patch: Partial<SlotState>) => {
    setSlotStates((curr) => ({
      ...curr,
      [slotId]: { ...curr[slotId], ...patch },
    }));
  };

  // 5. Generate ONE
  const generateOneMutation = useMutation({
    mutationFn: async (args: { slotId: string; invoiceId: string; encf: string }) => {
      updateSlotState(args.slotId, { isGenerating: true, error: null });
      const blob = await downloadPdf(args.invoiceId);
      return { slotId: args.slotId, encf: args.encf, blob };
    },
    onSuccess: ({ slotId, encf, blob }) => {
      updateSlotState(slotId, { pdf: blob, pdfSize: blob.size, isGenerating: false });
      toast.success(`PDF generado: ${encf}`);
    },
    onError: (err, args) => {
      const msg = getErrorMessage(err);
      updateSlotState(args.slotId, { isGenerating: false, error: msg });
      toast.error(`Error en ${args.slotId}: ${msg}`);
    },
  });

  // 6. Generate ALL
  const generateAllMutation = useMutation({
    mutationFn: async () => {
      let ok = 0;
      let fail = 0;
      for (const slot of slots) {
        if (!slot.invoice || slot.state.pdf) continue;
        try {
          updateSlotState(slot.slotId, { isGenerating: true, error: null });
          const blob = await downloadPdf(slot.invoice.id);
          updateSlotState(slot.slotId, { pdf: blob, pdfSize: blob.size, isGenerating: false });
          ok++;
        } catch (err) {
          updateSlotState(slot.slotId, { isGenerating: false, error: getErrorMessage(err) });
          fail++;
        }
      }
      return { ok, fail };
    },
    onSuccess: ({ ok, fail }) => {
      if (fail === 0) toast.success(`Generados ${ok} PDFs correctamente`);
      else toast.error(`${ok} generados, ${fail} con error`);
    },
  });

  // 7. Download single
  const downloadOne = (slot: typeof slots[number]) => {
    if (!slot.state.pdf || !slot.invoice) return;
    downloadBlob(slot.state.pdf, `${slot.invoice.encf}.pdf`);
  };

  // 8. Preview single
  const previewOne = (slot: typeof slots[number]) => {
    if (!slot.state.pdf) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(slot.state.pdf));
  };

  // 9. Download ZIP
  const downloadAllZip = async () => {
    const generated = slots.filter((s) => s.state.pdf && s.invoice);
    if (!generated.length) {
      toast.error('No hay PDFs generados todavía');
      return;
    }
    const zip = new JSZip();
    for (const slot of generated) {
      const arrayBuf = await slot.state.pdf!.arrayBuffer();
      zip.file(`${slot.invoice!.encf}.pdf`, arrayBuf);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const company = certCompanies.find((c) => c.id === selectedCompanyId);
    const rnc = company?.rnc ?? 'paso5';
    const fileName = `RI-Paso5-${rnc}-${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBlob(zipBlob, fileName);
    toast.success(`ZIP descargado con ${generated.length} PDFs`);
  };

  // 10. Clear all
  const clearAll = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    const reset: Record<string, SlotState> = {};
    for (const s of REQUIRED_SLOTS) reset[s.slotId] = { ...INITIAL_SLOT_STATE };
    setSlotStates(reset);
  };

  // ─── Computed ──────────────────────────────────────────────
  const generatedCount = slots.filter((s) => s.state.pdf).length;
  const totalBytes = slots.reduce((sum, s) => sum + s.state.pdfSize, 0);
  const totalMb = totalBytes / 1024 / 1024;
  const overLimit = totalMb > MAX_TOTAL_SIZE_MB;
  const missingInvoiceCount = slots.filter((s) => !s.invoice).length;
  const canGenerateAny = slots.some((s) => s.invoice && !s.state.pdf);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="h-6 w-6" /> Certificación DGII — Paso 5: Representación Impresa
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generá los 11 PDFs de los e-CF del Paso 4 para subir al portal DGII.
          La suma total no debe superar 10 MB.
        </p>
      </div>

      {/* Step 1: Company */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Seleccionar empresa</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <label className="text-sm font-medium">Empresa (CERT)</label>
            {companiesLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : certCompanies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay empresas CERT.</p>
            ) : (
              <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccioná la empresa..." />
                </SelectTrigger>
                <SelectContent>
                  {certCompanies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.businessName} — {c.rnc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step 2: PDFs */}
      {selectedCompanyId && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                2. PDFs requeridos ({generatedCount}/11 generados)
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Tamaño total:{' '}
                <span className={overLimit ? 'text-destructive font-semibold' : ''}>
                  {bytesToMb(totalBytes)} MB
                </span>
                {' / '}
                {MAX_TOTAL_SIZE_MB} MB
              </p>
              {missingInvoiceCount > 0 && (
                <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Faltan {missingInvoiceCount} invoices del Paso 4 (slots vacíos no se podrán generar).
                </p>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant="outline" onClick={clearAll} disabled={generatedCount === 0} className="gap-1">
                <Trash2 className="h-3 w-3" /> Limpiar
              </Button>
              <Button
                size="sm"
                onClick={() => generateAllMutation.mutate()}
                disabled={generateAllMutation.isPending || !canGenerateAny}
                className="gap-2"
              >
                {generateAllMutation.isPending ? (
                  <><Loader2 className="h-3 w-3 animate-spin" />Generando...</>
                ) : (
                  <><FileDown className="h-3 w-3" />Generar todos</>
                )}
              </Button>
              <Button
                size="sm"
                onClick={downloadAllZip}
                disabled={generatedCount === 0 || overLimit}
                className="gap-2"
              >
                <Package className="h-3 w-3" />
                ZIP ({generatedCount})
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {invoicesLoading ? (
              <Skeleton className="h-60 w-full" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      <th className="pb-2 pr-3">Tipo</th>
                      <th className="pb-2 pr-3">Descripción</th>
                      <th className="pb-2 pr-3">eNCF</th>
                      <th className="pb-2 pr-3">Monto</th>
                      <th className="pb-2 pr-3">Estado</th>
                      <th className="pb-2 pr-3 text-right">Tamaño</th>
                      <th className="pb-2 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((slot) => (
                      <tr key={slot.slotId} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-mono text-xs font-semibold">
                          {slot.slotId.replace('-grande', '').replace('-rfce', '')}
                          {slot.isRfce && (
                            <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0">
                              RFCE
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs">{slot.label}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {slot.invoice?.encf ?? (
                            <span className="text-muted-foreground italic">Sin invoice</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-right">
                          {slot.invoice
                            ? Number(slot.invoice.totalAmount).toLocaleString('es-DO', {
                                minimumFractionDigits: 2,
                              })
                            : '—'}
                        </td>
                        <td className="py-2 pr-3">
                          {slot.state.isGenerating ? (
                            <Badge variant="secondary" className="gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />Generando
                            </Badge>
                          ) : slot.state.pdf ? (
                            <Badge variant="default" className="gap-1">
                              <CheckCircle2 className="h-3 w-3" />Listo
                            </Badge>
                          ) : slot.state.error ? (
                            <Badge variant="destructive" className="gap-1">
                              <AlertCircle className="h-3 w-3" />Error
                            </Badge>
                          ) : slot.invoice ? (
                            <Badge variant="outline">Pendiente</Badge>
                          ) : (
                            <Badge variant="outline" className="opacity-50">—</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-right text-xs">
                          {slot.state.pdf ? `${bytesToMb(slot.state.pdfSize)} MB` : '—'}
                        </td>
                        <td className="py-2 text-right">
                          <div className="inline-flex gap-1">
                            {!slot.state.pdf && slot.invoice && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  generateOneMutation.mutate({
                                    slotId: slot.slotId,
                                    invoiceId: slot.invoice!.id,
                                    encf: slot.invoice!.encf,
                                  })
                                }
                                disabled={slot.state.isGenerating}
                              >
                                {slot.state.isGenerating ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  'Generar'
                                )}
                              </Button>
                            )}
                            {slot.state.pdf && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => previewOne(slot)} title="Ver preview">
                                  <Eye className="h-3 w-3" />
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => downloadOne(slot)} title="Descargar">
                                  <Download className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                          </div>
                          {slot.state.error && (
                            <p className="text-[10px] text-destructive mt-1 max-w-xs ml-auto">
                              {slot.state.error}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* PDF Preview */}
      {previewUrl && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Preview PDF</CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                URL.revokeObjectURL(previewUrl);
                setPreviewUrl(null);
              }}
            >
              Cerrar
            </Button>
          </CardHeader>
          <CardContent>
            <iframe src={previewUrl} className="w-full h-[700px] border rounded" title="PDF preview" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}