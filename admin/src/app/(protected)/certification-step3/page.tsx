'use client';

import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileCheck2, Upload, Loader2, CheckCircle2, XCircle, AlertCircle, Clock,
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

interface Step3Document {
  id: string;
  encf: string;
  ecfType: string;
  totalAmount: string;
  intendedEstado: 1 | 2;
  status: 'PENDING' | 'BUILDING' | 'SIGNING' | 'SUBMITTING' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'ERROR';
  trackId: string | null;
  errorMessage: string | null;
}

// ============================================================================
// API calls
// ============================================================================

async function fetchCompanies(): Promise<Company[]> {
  const res = await apiClient.get<{ data: Company[] }>('/companies');
  return res.data.data;
}

async function uploadStep3Excel(params: { companyId: string; file: File }) {
  const form = new FormData();
  form.append('file', params.file);
  form.append('companyId', params.companyId);
  const res = await apiClient.post('/certification-step3/upload-excel', form, {
    headers: { 'Content-Type': undefined as unknown as string },
    timeout: 60_000,
  });
  return (res.data as any)?.data ?? res.data;
}

async function fetchDocuments(companyId: string): Promise<Step3Document[]> {
  const res = await apiClient.get<{ data: Step3Document[] }>(
    `/certification-step3/documents/${companyId}`,
  );
  return res.data.data ?? (res.data as any);
}

async function processAll(companyId: string) {
  const res = await apiClient.post(`/certification-step3/process-all/${companyId}`);
  return (res.data as any)?.data ?? res.data;
}

// ============================================================================
// Helpers
// ============================================================================

const TERMINAL = new Set(['ACCEPTED', 'REJECTED', 'ERROR']);
const isTerminal = (s: Step3Document['status']) => TERMINAL.has(s);

function statusBadge(s: Step3Document['status']) {
  const cfg: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; spin?: boolean }> = {
    PENDING:    { label: 'Pendiente',  variant: 'secondary' },
    BUILDING:   { label: 'Construyendo', variant: 'secondary', spin: true },
    SIGNING:    { label: 'Firmando',   variant: 'secondary', spin: true },
    SUBMITTING: { label: 'Enviando',   variant: 'secondary', spin: true },
    SENT:       { label: 'Enviado',    variant: 'secondary', spin: true },
    ACCEPTED:   { label: 'Aceptado',   variant: 'default' },
    REJECTED:   { label: 'Rechazado',  variant: 'destructive' },
    ERROR:      { label: 'Error',      variant: 'destructive' },
  };
  const e = cfg[s] ?? { label: s, variant: 'outline' as const };
  const Icon = e.spin ? Loader2 : s === 'ACCEPTED' ? CheckCircle2 : s === 'ERROR' || s === 'REJECTED' ? XCircle : Clock;
  return (
    <Badge variant={e.variant} className="gap-1">
      <Icon className={`h-3 w-3 ${e.spin ? 'animate-spin' : ''}`} />
      {e.label}
    </Badge>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function CertificationStep3Page() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { data: companies = [], isLoading: companiesLoading } = useQuery({
    queryKey: ['my', 'companies'],
    queryFn: fetchCompanies,
  });
  const certCompanies = companies.filter(c => c.dgiiEnv === 'CERT');

  const { data: documents = [], isLoading: docsLoading } = useQuery({
    queryKey: ['step3', 'documents', selectedCompanyId],
    queryFn: () => fetchDocuments(selectedCompanyId),
    enabled: !!selectedCompanyId,
    refetchInterval: (q) => {
      const docs: Step3Document[] = q.state.data ?? [];
      if (!docs.length) return false;
      return docs.every(d => isTerminal(d.status)) ? false : 3000;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: uploadStep3Excel,
    onSuccess: (result) => {
      toast.success(`${result.created} documentos cargados. ${result.excluded} tipos excluidos.`);
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: { message?: string }; message?: string } } };
      toast.error(e.response?.data?.error?.message ?? e.response?.data?.message ?? 'Error subiendo el Excel');
    },
  });

  const processAllMutation = useMutation({
    mutationFn: () => processAll(selectedCompanyId),
    onSuccess: (r) => toast.success(`Procesados: ${r.processed} documentos`),
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message ?? 'Error procesando documentos');
    },
  });

  const accepted = documents.filter(d => d.status === 'ACCEPTED').length;
  const pending = documents.filter(d => !isTerminal(d.status)).length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileCheck2 className="h-6 w-6" /> Certificación DGII — Paso 3: Aprobaciones Comerciales
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enviá los 11 ACECF del Paso 3 (Excel ACEECF_Generadas provisto por DGII).
        </p>
      </div>

      {/* Upload card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Subir Excel del Paso 3</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Empresa (CERT)</label>
            {companiesLoading ? <Skeleton className="h-10 w-full" /> : certCompanies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay empresas CERT.</p>
            ) : (
              <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                <SelectTrigger><SelectValue placeholder="Seleccioná la empresa..." /></SelectTrigger>
                <SelectContent>
                  {certCompanies.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.businessName} — {c.rnc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Excel ACEECF_Generadas (.xlsx)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-secondary file:text-secondary-foreground hover:file:bg-secondary/80"
            />
          </div>

          <Button
            onClick={() => uploadMutation.mutate({ companyId: selectedCompanyId, file: selectedFile! })}
            disabled={!selectedCompanyId || !selectedFile || uploadMutation.isPending}
            className="gap-2"
          >
            {uploadMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" />Cargando...</> : <><Upload className="h-4 w-4" />Subir Excel</>}
          </Button>
        </CardContent>
      </Card>

      {/* Documents table */}
      {selectedCompanyId && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              2. Documentos ({accepted}/{documents.length} aceptados)
            </CardTitle>
            <Button
              size="sm"
              onClick={() => processAllMutation.mutate()}
              disabled={!documents.length || pending === 0 || processAllMutation.isPending}
              className="gap-2"
            >
              {processAllMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" />Procesando...</> : 'Procesar todos'}
            </Button>
          </CardHeader>
          <CardContent>
            {docsLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay documentos cargados. Subí el Excel primero.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr className="text-left">
                      <th className="pb-2 pr-3">eNCF</th>
                      <th className="pb-2 pr-3">Tipo</th>
                      <th className="pb-2 pr-3">Monto</th>
                      <th className="pb-2 pr-3">Estado DGII</th>
                      <th className="pb-2 pr-3">Status</th>
                      <th className="pb-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map(doc => (
                      <tr key={doc.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-mono text-xs">{doc.encf}</td>
                        <td className="py-2 pr-3 text-xs">{doc.ecfType}</td>
                        <td className="py-2 pr-3 tabular-nums text-right">
                          {Number(doc.totalAmount).toLocaleString('es-DO', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {doc.intendedEstado === 1 ? '1 (Aceptar)' : '2 (Rechazar)'}
                        </td>
                        <td className="py-2 pr-3">{statusBadge(doc.status)}</td>
                        <td className="py-2 max-w-xs">
                          {doc.errorMessage ? (
                            <details className="text-xs text-destructive">
                              <summary className="cursor-pointer">Ver error</summary>
                              <pre className="mt-1 p-1 bg-muted rounded text-[10px] whitespace-pre-wrap break-all">
                                {doc.errorMessage}
                              </pre>
                            </details>
                          ) : '—'}
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
    </div>
  );
}
