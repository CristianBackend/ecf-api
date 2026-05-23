'use client';

import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileCheck2, Upload, Loader2, CheckCircle2, XCircle, Clock, AlertCircle, Download,
} from 'lucide-react';
import { toast } from 'sonner';
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

interface UploadResult {
  uploadId: string;
  totalRows: number;
  created: number;
  invoices: Array<{ id: string; encf: string | null; ecfType: string; totalAmount: number }>;
  errors: Array<{ row: number; encf?: string; error: string }>;
}

interface InvoiceStatus {
  id: string;
  encf: string | null;
  ecfType: string;
  status:
    | 'QUEUED' | 'SIGNING' | 'SUBMITTING' | 'SENT' | 'IN_PROGRESS'
    | 'ACCEPTED' | 'CONDITIONAL' | 'REJECTED' | 'ERROR' | 'CONTINGENCY' | 'PROCESSING';
  trackId: string | null;
  totalAmount: string;
  dgiiMessage: string | null;
  signedAt: string | null;
}

// ============================================================================
// API calls
// ============================================================================

async function fetchCompanies(): Promise<Company[]> {
  const res = await apiClient.get<{ data: Company[] }>('/companies');
  return res.data.data;
}

async function uploadExcel(params: { companyId: string; file: File; skipEncfs?: string }): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', params.file);
  form.append('companyId', params.companyId);
  if (params.skipEncfs && params.skipEncfs.trim()) {
    form.append('skipEncfs', params.skipEncfs.trim());
  }

  // For multipart, let axios/browser compute the Content-Type with the correct
  // boundary by passing `undefined` — passing 'multipart/form-data' without
  // boundary causes the backend to fail parsing.
  const res = await apiClient.post<{ data: UploadResult } | UploadResult>(
    '/certification/upload-excel',
    form,
    {
      headers: { 'Content-Type': undefined as unknown as string },
      timeout: 120_000,
    },
  );

  // The endpoint returns the result directly (not wrapped in { data })
  const body = res.data as UploadResult & { data?: UploadResult };
  return body.data ?? (body as UploadResult);
}

async function fetchInvoiceStatus(id: string): Promise<InvoiceStatus> {
  const res = await apiClient.get<{ data: InvoiceStatus }>(`/invoices/${id}`);
  return res.data.data;
}

/**
 * Fix 4r: Download the ZIP with the ECF (íntegro) XMLs of E32 invoices that
 * were summarized as RFCE. Used for the second part of DGII Step 2:
 * "Facturas de Consumo < 250 Mil" requires uploading each E32 invoice's
 * íntegro XML individually after its RFCE summary was already accepted.
 *
 * The backend filters by company + ecfType='E32' + isRfce=true + status='ACCEPTED'.
 * If no invoices match (no RFCE accepted yet), the backend returns 404 and
 * the user sees a toast.
 */
async function downloadRfceSourceZip(companyId: string): Promise<void> {
  const res = await apiClient.get(
    `/certification/rfce-source-xmls/zip`,
    {
      params: { companyId },
      responseType: 'blob',
      timeout: 60_000,
    },
  );

  // Trigger browser download
  const blob = new Blob([res.data as BlobPart], { type: 'application/zip' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rfce-source-xmls.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// ============================================================================
// Helpers
// ============================================================================

function isTerminal(status: InvoiceStatus['status']): boolean {
  return ['ACCEPTED', 'CONDITIONAL', 'REJECTED', 'ERROR'].includes(status);
}

function statusBadge(s: InvoiceStatus['status']) {
  const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon?: React.ComponentType<{ className?: string }> }> = {
    QUEUED:      { label: 'En cola',            variant: 'secondary', icon: Clock },
    SIGNING:     { label: 'Firmando',           variant: 'secondary', icon: Loader2 },
    SUBMITTING:  { label: 'Enviando',           variant: 'secondary', icon: Loader2 },
    SENT:        { label: 'Esperando DGII',     variant: 'secondary', icon: Loader2 },
    IN_PROGRESS: { label: 'En proceso DGII',    variant: 'secondary', icon: Loader2 },
    PROCESSING:  { label: 'Procesando',         variant: 'secondary', icon: Loader2 },
    ACCEPTED:    { label: 'Aceptada',           variant: 'default',   icon: CheckCircle2 },
    CONDITIONAL: { label: 'Aceptada cond.',     variant: 'default',   icon: CheckCircle2 },
    REJECTED:    { label: 'Rechazada',          variant: 'destructive', icon: XCircle },
    ERROR:       { label: 'Error',              variant: 'destructive', icon: AlertCircle },
    CONTINGENCY: { label: 'Contingencia',       variant: 'outline',   icon: AlertCircle },
  };
  const entry = map[s] ?? { label: s, variant: 'outline' as const };
  const Icon = entry.icon;
  return (
    <Badge variant={entry.variant} className="gap-1">
      {Icon && <Icon className={`h-3 w-3 ${['SIGNING','SUBMITTING','SENT','IN_PROGRESS','PROCESSING'].includes(s) ? 'animate-spin' : ''}`} />}
      {entry.label}
    </Badge>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function CertificationPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  // Fix 4q: optional comma-separated eNCFs to skip. Use for DGII
  // certification when prior submissions consumed sequences that would
  // now fail with "secuencia ya utilizada", contaminating the upload.
  const [skipEncfs, setSkipEncfs] = useState<string>('');
  // Fix 4r: download state for the RFCE-source ZIP
  const [downloadingRfce, setDownloadingRfce] = useState(false);
  const [rfceDownloadError, setRfceDownloadError] = useState<string | null>(null);

  const { data: companies = [], isLoading: companiesLoading } = useQuery({
    queryKey: ['my', 'companies'],
    queryFn: fetchCompanies,
  });

  // Filter to only CERT environment companies — DGII certification only runs there
  const certCompanies = companies.filter(c => c.dgiiEnv === 'CERT');

  const uploadMutation = useMutation({
    mutationFn: uploadExcel,
    onSuccess: (result) => {
      setUploadResult(result);
      toast.success(
        `${result.created} de ${result.totalRows} facturas creadas. ${result.errors.length} errores de mapeo.`,
        { duration: 6000 },
      );
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: { message?: string }; message?: string } } };
      const msg = e.response?.data?.error?.message ?? e.response?.data?.message ?? 'Error desconocido subiendo el Excel';
      toast.error(msg, { duration: 10000 });
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toast.error('Solo se aceptan archivos .xlsx');
      return;
    }
    setSelectedFile(file);
  }

  function handleSubmit() {
    if (!selectedCompanyId) {
      toast.error('Seleccioná una empresa');
      return;
    }
    if (!selectedFile) {
      toast.error('Seleccioná el archivo Excel');
      return;
    }
    uploadMutation.mutate({
      companyId: selectedCompanyId,
      file: selectedFile,
      skipEncfs: skipEncfs.trim() || undefined,
    });
  }

  function handleReset() {
    setUploadResult(null);
    setSelectedFile(null);
    // Note: skipEncfs is intentionally NOT reset — it's typically the same
    // across retries within a certification attempt.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileCheck2 className="h-6 w-6" /> Certificación DGII
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Subí el Excel del set de pruebas (paso 2 de la certificación DGII) y se enviarán todos los casos automáticamente al ambiente CerteCF.
        </p>
      </div>

      {/* ---------- Upload card ---------- */}
      {!uploadResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Subir Excel del set de pruebas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Empresa emisora (CERT)</label>
              {companiesLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : certCompanies.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No hay empresas con ambiente CERT. Creá una desde &quot;Mis Empresas&quot; o ajustá el dgiiEnv de una existente.
                </p>
              ) : (
                <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Seleccioná la empresa..." />
                  </SelectTrigger>
                  <SelectContent>
                    {certCompanies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.businessName} — RNC {c.rnc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Archivo Excel (.xlsx)</label>
              <div className="flex items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  onChange={handleFileChange}
                  className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground hover:file:bg-secondary/80"
                />
              </div>
              {selectedFile && (
                <p className="text-xs text-muted-foreground">
                  Listo: {selectedFile.name} — {(selectedFile.size / 1024).toFixed(1)} KB
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                eNCFs a omitir <span className="text-muted-foreground font-normal">(opcional)</span>
              </label>
              <input
                type="text"
                value={skipEncfs}
                onChange={(e) => setSkipEncfs(e.target.value)}
                placeholder="E320000000006,E460000000009"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Separados por coma. Útil cuando una secuencia ya fue consumida en DGII (errores
                &quot;Este número de secuencia ya ha sido utilizado&quot;) y un nuevo envío la
                rechazaría, reiniciando el contador del portal.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <Button
                onClick={handleSubmit}
                disabled={!selectedCompanyId || !selectedFile || uploadMutation.isPending}
                className="gap-2"
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Procesando Excel...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Subir y enviar a DGII
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Esto puede tardar 30-60 segundos. Se va a crear una factura por cada caso del Excel y se encolará para envío a DGII.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- Fix 4r: Download RFCE-source XMLs for "Facturas Consumo < 250 Mil" ---------- */}
      {!uploadResult && selectedCompanyId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              2. Descargar XMLs para &quot;Facturas de Consumo &lt; 250 Mil&quot;
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Después de que las RFCE estén aceptadas (4/4 Resúmenes), el portal DGII pide subir
              los XMLs íntegros de cada E32 que fue resumida. Este botón te descarga un ZIP con
              los XMLs firmados, listos para subir uno por uno al portal en la sección{' '}
              <span className="font-medium">&quot;Facturas de consumo &lt; 250 Mil&quot;</span>.
            </p>
            <Button
              variant="outline"
              onClick={async () => {
                setRfceDownloadError(null);
                setDownloadingRfce(true);
                try {
                  await downloadRfceSourceZip(selectedCompanyId);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : 'Error desconocido';
                  setRfceDownloadError(
                    msg.includes('404')
                      ? 'No hay facturas E32 con RFCE aceptado todavía. Primero hacé el upload del Excel y esperá a que pasen.'
                      : msg,
                  );
                } finally {
                  setDownloadingRfce(false);
                }
              }}
              disabled={downloadingRfce}
            >
              {downloadingRfce ? 'Generando ZIP…' : 'Descargar ZIP de XMLs RFCE'}
            </Button>
            {rfceDownloadError && (
              <p className="text-sm text-destructive">{rfceDownloadError}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---------- Results ---------- */}
      {uploadResult && (
        <UploadResultsView result={uploadResult} onReset={handleReset} />
      )}
    </div>
  );
}

// ============================================================================
// Results component (polling)
// ============================================================================

function UploadResultsView({ result, onReset }: { result: UploadResult; onReset: () => void }) {
  // Poll status for each invoice individually until terminal
  const invoiceIds = result.invoices.map(i => i.id);

  const queries = useQuery({
    queryKey: ['certification', 'invoices', result.uploadId],
    queryFn: async () => {
      const statuses = await Promise.all(invoiceIds.map(id => fetchInvoiceStatus(id)));
      return statuses;
    },
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 2000;
      const allDone = data.every((inv: InvoiceStatus) => isTerminal(inv.status));
      return allDone ? false : 3000;
    },
    enabled: invoiceIds.length > 0,
  });

  const invoices = queries.data ?? [];
  const counters = {
    total: invoices.length,
    accepted: invoices.filter(i => i.status === 'ACCEPTED' || i.status === 'CONDITIONAL').length,
    rejected: invoices.filter(i => i.status === 'REJECTED').length,
    error:    invoices.filter(i => i.status === 'ERROR').length,
    pending:  invoices.filter(i => !isTerminal(i.status)).length,
  };

  return (
    <div className="space-y-4">
      {/* Counters bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <CounterTile label="Total" value={result.totalRows} variant="muted" />
            <CounterTile label="Aceptadas" value={counters.accepted} variant="success" />
            <CounterTile label="Rechazadas" value={counters.rejected} variant="danger" />
            <CounterTile label="Errores" value={counters.error} variant="danger" />
            <CounterTile label="Pendientes" value={counters.pending} variant="warning" />
          </div>
          {result.errors.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-3">
              {result.errors.length} fila(s) no se pudieron mapear (no se enviaron a DGII). Detalles abajo.
            </p>
          )}
          <div className="flex items-center gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={onReset}>Subir otro Excel</Button>
            {counters.pending === 0 && counters.accepted === result.created && (
              <Badge variant="default" className="ml-auto gap-1">
                <CheckCircle2 className="h-3 w-3" /> Todas aceptadas
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Invoices table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Facturas creadas ({result.created})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr className="text-left">
                  <th className="pb-2 pr-3">Tipo</th>
                  <th className="pb-2 pr-3">eNCF</th>
                  <th className="pb-2 pr-3">Monto</th>
                  <th className="pb-2 pr-3">Estado</th>
                  <th className="pb-2 pr-3">TrackId</th>
                  <th className="pb-2">Mensaje DGII</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{inv.ecfType}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{inv.encf ?? '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {Number(inv.totalAmount).toLocaleString('es-DO', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 pr-3">{statusBadge(inv.status)}</td>
                    <td className="py-2 pr-3 font-mono text-[10px] text-muted-foreground">
                      {inv.trackId ? inv.trackId.slice(0, 8) + '...' : '—'}
                    </td>
                    <td className="py-2 max-w-md">
                      {inv.dgiiMessage ? (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer hover:text-foreground">
                            Ver detalle
                          </summary>
                          <pre className="mt-2 p-2 bg-muted rounded text-[10px] whitespace-pre-wrap break-all">
                            {inv.dgiiMessage}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Errores de mapeo */}
      {result.errors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              Filas que no se pudieron procesar ({result.errors.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {result.errors.map((e, i) => (
                <li key={i} className="border-l-2 border-destructive pl-3 py-1">
                  <p className="font-mono text-xs">
                    Fila {e.row}{e.encf ? ` (${e.encf})` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{e.error}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CounterTile({
  label, value, variant,
}: { label: string; value: number; variant: 'muted' | 'success' | 'danger' | 'warning' }) {
  const styles: Record<string, string> = {
    muted:   'bg-muted text-muted-foreground',
    success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    danger:  'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  };
  return (
    <div className={`rounded-lg p-3 ${styles[variant]}`}>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs">{label}</p>
    </div>
  );
}
