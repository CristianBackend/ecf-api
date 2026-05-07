'use client';

import { use, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft, Building2, Shield, FileText, ListOrdered, Plus, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber } from '@/lib/utils';
import type { Company, Certificate, Sequence, Invoice } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CertificateUploadDialog } from '@/components/tenants/certificate-upload-dialog';
import { InvoiceDetailDrawer } from '@/components/invoices/invoice-detail-drawer';

const ECF_TYPES = ['E31','E32','E33','E34','E41','E43','E44','E45','E46','E47'] as const;
const ECF_LABELS: Record<string, string> = {
  E31: 'E31 — Crédito Fiscal', E32: 'E32 — Consumo', E33: 'E33 — Nota Débito',
  E34: 'E34 — Nota Crédito', E41: 'E41 — Compras', E43: 'E43 — Gastos Menores',
  E44: 'E44 — Regímenes Especiales', E45: 'E45 — Gubernamental',
  E46: 'E46 — Exportaciones', E47: 'E47 — Pagos al Exterior',
};
const STATUS_BADGE: Record<string, string> = {
  ACCEPTED: 'success', REJECTED: 'destructive', CONDITIONAL: 'warning',
  CONTINGENCY: 'warning', ERROR: 'destructive', VOIDED: 'secondary',
  QUEUED: 'info', PROCESSING: 'info', SENT: 'info', DRAFT: 'secondary',
};

// ── DTOs ──────────────────────────────────────────────────────────────────────

const editSchema = z.object({
  businessName: z.string().min(2).max(250),
  tradeName:    z.string().max(250).optional(),
  address:      z.string().max(500).optional(),
  municipality: z.string().max(100).optional(),
  province:     z.string().max(100).optional(),
  phone:        z.string().max(20).optional(),
  email:        z.string().email('Email inválido').optional().or(z.literal('')),
  dgiiEnv:      z.enum(['DEV', 'CERT', 'PROD']),
});
type EditForm = z.infer<typeof editSchema>;

const seqSchema = z.object({
  ecfType:     z.enum(ECF_TYPES),
  startNumber: z.number().int().min(1),
  endNumber:   z.number().int().min(2),
  expiresAt:   z.string().optional(),
}).refine((d) => d.endNumber > d.startNumber, {
  message: 'El número final debe ser mayor al inicial',
  path: ['endNumber'],
});
type SeqForm = z.infer<typeof seqSchema>;

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchCompany(id: string): Promise<Company> {
  const res = await apiClient.get<{ data: Company }>(`/companies/${id}`);
  return res.data.data;
}
async function fetchCerts(id: string): Promise<Certificate[]> {
  const res = await apiClient.get<{ data: Certificate[] }>(`/companies/${id}/certificates`);
  return res.data.data;
}
async function fetchSequences(id: string): Promise<Sequence[]> {
  const res = await apiClient.get<{ data: Sequence[] }>(`/sequences/${id}`);
  return res.data.data;
}
async function fetchInvoices(companyId: string): Promise<Invoice[]> {
  // Backend response body: { success, data: Invoice[], meta: {...} }
  // res.data = whole body; res.data.data = Invoice[]
  const res = await apiClient.get<{ success: boolean; data: Invoice[]; meta: unknown }>(`/invoices?companyId=${companyId}&limit=50`);
  return res.data.data ?? [];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [certOpen, setCertOpen] = useState(false);
  const [seqOpen, setSeqOpen] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  const { data: company, isLoading } = useQuery({ queryKey: ['my', 'company', id], queryFn: () => fetchCompany(id) });
  const { data: certs = [] } = useQuery({ queryKey: ['my', 'company-certs', id], queryFn: () => fetchCerts(id) });
  const { data: sequences = [] } = useQuery({ queryKey: ['my', 'sequences', id], queryFn: () => fetchSequences(id) });
  const { data: invoices = [] } = useQuery({ queryKey: ['my', 'company-invoices', id], queryFn: () => fetchInvoices(id) });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<EditForm>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(editSchema) as any,
    values: company ? {
      businessName: company.businessName,
      tradeName: company.tradeName ?? '',
      address: company.address ?? '',
      municipality: (company as Company & { municipality?: string }).municipality ?? '',
      province: (company as Company & { province?: string }).province ?? '',
      phone: company.phone ?? '',
      email: company.email ?? '',
      dgiiEnv: company.dgiiEnv,
    } : undefined,
  });

  const editMutation = useMutation({
    mutationFn: (dto: EditForm) => apiClient.patch(`/companies/${id}`, dto),
    onSuccess: () => {
      toast.success('Empresa actualizada');
      void queryClient.invalidateQueries({ queryKey: ['my', 'company', id] });
    },
    onError: () => toast.error('Error al actualizar la empresa'),
  });

  const {
    register: regSeq,
    handleSubmit: handleSeq,
    watch: watchSeq,
    setValue: setSeqVal,
    reset: resetSeq,
    formState: { errors: seqErrors },
  } = useForm<SeqForm>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(seqSchema) as any,
    defaultValues: { ecfType: 'E31', startNumber: 1, endNumber: 10000 },
  });

  const seqMutation = useMutation({
    mutationFn: (dto: SeqForm) =>
      apiClient.post('/sequences', { ...dto, companyId: id }),
    onSuccess: () => {
      toast.success('Secuencia registrada');
      setSeqOpen(false);
      resetSeq();
      void queryClient.invalidateQueries({ queryKey: ['my', 'sequences', id] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Error al registrar la secuencia';
      toast.error(msg);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!company) return null;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{company.businessName}</h1>
            <Badge variant={company.isActive ? 'success' : 'secondary'}>
              {company.isActive ? 'Activa' : 'Inactiva'}
            </Badge>
            <Badge variant="outline">{company.dgiiEnv}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1 font-mono">{company.rnc}</p>
        </div>
      </div>

      <Tabs defaultValue="datos">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="datos"><Building2 className="h-4 w-4 mr-1.5" />Datos</TabsTrigger>
          <TabsTrigger value="certificados"><Shield className="h-4 w-4 mr-1.5" />Certificados</TabsTrigger>
          <TabsTrigger value="secuencias"><ListOrdered className="h-4 w-4 mr-1.5" />Secuencias</TabsTrigger>
          <TabsTrigger value="facturas"><FileText className="h-4 w-4 mr-1.5" />Facturas</TabsTrigger>
        </TabsList>

        {/* ── Tab Datos ──────────────────────────────────────────────────── */}
        <TabsContent value="datos">
          <Card>
            <CardContent className="pt-6">
              <form onSubmit={handleSubmit((d) => editMutation.mutate(d))} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Razón Social *" error={errors.businessName?.message}>
                    <Input {...register('businessName')} />
                  </Field>
                  <Field label="Nombre Comercial" error={errors.tradeName?.message}>
                    <Input {...register('tradeName')} />
                  </Field>
                  <Field label="Dirección" error={errors.address?.message} className="sm:col-span-2">
                    <Input {...register('address')} />
                  </Field>
                  <Field label="Municipio">
                    <Input {...register('municipality')} />
                  </Field>
                  <Field label="Provincia">
                    <Input {...register('province')} />
                  </Field>
                  <Field label="Teléfono">
                    <Input {...register('phone')} />
                  </Field>
                  <Field label="Email">
                    <Input type="email" {...register('email')} />
                  </Field>
                  <Field label="Ambiente DGII">
                    <Select
                      value={watch('dgiiEnv') ?? company.dgiiEnv}
                      onValueChange={(v) => setValue('dgiiEnv', v as 'DEV' | 'CERT' | 'PROD')}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent position="popper" className="z-[200]">
                        <SelectItem value="DEV">Desarrollo</SelectItem>
                        <SelectItem value="CERT">Certificación</SelectItem>
                        <SelectItem value="PROD">Producción</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={editMutation.isPending}>
                    {editMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Guardar cambios
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab Certificados ───────────────────────────────────────────── */}
        <TabsContent value="certificados">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4" /> Certificados .p12
              </CardTitle>
              <Button size="sm" className="gap-1.5" onClick={() => setCertOpen(true)}>
                <Plus className="h-4 w-4" /> Subir
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {certs.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin certificados subidos</p>
              ) : (
                <div className="divide-y">
                  {certs.map((cert) => {
                    const daysLeft = Math.ceil((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
                    const expired = daysLeft < 0;
                    const expiringSoon = !expired && daysLeft <= 30;
                    return (
                      <div key={cert.id} className="flex items-center justify-between px-4 py-3">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant={cert.isActive ? 'success' : 'secondary'}>
                              {cert.isActive ? 'Activo' : 'Inactivo'}
                            </Badge>
                            {expired && <Badge variant="destructive">Vencido</Badge>}
                            {expiringSoon && <Badge variant="warning">Vence en {daysLeft}d</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {cert.signerName ?? 'Firmante desconocido'} · Válido hasta {fmtDate(cert.validTo)}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground shrink-0">{fmtDate(cert.createdAt)}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
          <CertificateUploadDialog
            open={certOpen}
            onOpenChange={setCertOpen}
            companies={[company]}
            tenantId={company.tenantId}
            onSuccess={() => void queryClient.invalidateQueries({ queryKey: ['my', 'company-certs', id] })}
          />
        </TabsContent>

        {/* ── Tab Secuencias ─────────────────────────────────────────────── */}
        <TabsContent value="secuencias">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ListOrdered className="h-4 w-4" /> Secuencias e-CF
              </CardTitle>
              <Button size="sm" className="gap-1.5" onClick={() => setSeqOpen(true)}>
                <Plus className="h-4 w-4" /> Nueva
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {sequences.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin secuencias configuradas</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      {['Tipo', 'Rango', 'Progreso', 'Vencimiento', 'Estado'].map((h) => (
                        <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sequences.map((seq) => {
                      const used = seq.currentNumber - seq.startNumber;
                      const total = seq.endNumber - seq.startNumber + 1;
                      const pct = total > 0 ? Math.round((used / total) * 100) : 0;
                      const expSoon = seq.expiresAt && Math.ceil((new Date(seq.expiresAt).getTime() - Date.now()) / 86400000) <= 30;
                      return (
                        <tr key={seq.id} className="border-b">
                          <td className="px-4 py-2">
                            <span className="font-mono text-xs font-bold">{seq.ecfType}</span>
                            <span className="text-xs text-muted-foreground ml-1">{ECF_LABELS[seq.ecfType]?.split(' — ')[1]}</span>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {fmtNumber(seq.startNumber)}–{fmtNumber(seq.endNumber)}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-xs text-muted-foreground">{pct}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-xs">
                            {seq.expiresAt ? (
                              <span className={expSoon ? 'text-amber-600 font-medium' : 'text-muted-foreground'}>
                                {fmtDate(seq.expiresAt)}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant={seq.isActive ? 'success' : 'secondary'}>
                              {seq.isActive ? 'Activa' : 'Inactiva'}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Create sequence dialog */}
          <Dialog open={seqOpen} onOpenChange={(v) => { setSeqOpen(v); if (!v) resetSeq(); }}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Nueva Secuencia e-CF</DialogTitle>
                <DialogDescription>
                  Ingresá el rango de eNCF autorizado por DGII para esta empresa.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSeq((d) => seqMutation.mutate(d))} className="space-y-4">
                <Field label="Tipo e-CF *">
                  <Select value={watchSeq('ecfType')} onValueChange={(v) => setSeqVal('ecfType', v as typeof ECF_TYPES[number])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" className="z-[200]">
                      {ECF_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{ECF_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Número inicio *" error={seqErrors.startNumber?.message}>
                    <Input type="number" min={1} {...regSeq('startNumber', { valueAsNumber: true })} />
                  </Field>
                  <Field label="Número fin *" error={seqErrors.endNumber?.message}>
                    <Input type="number" min={2} {...regSeq('endNumber', { valueAsNumber: true })} />
                  </Field>
                </div>
                <Field label="Fecha vencimiento">
                  <Input type="date" {...regSeq('expiresAt')} />
                </Field>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setSeqOpen(false)}>Cancelar</Button>
                  <Button type="submit" disabled={seqMutation.isPending}>
                    {seqMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Registrar Secuencia
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* ── Tab Facturas ───────────────────────────────────────────────── */}
        <TabsContent value="facturas">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Facturas recientes
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {invoices.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin facturas emitidas</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      {['e-NCF', 'Comprador', 'Tipo', 'Estado', 'Monto', 'Fecha'].map((h) => (
                        <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => setSelectedInvoiceId(inv.id)}
                      >
                        <td className="px-4 py-2 font-mono text-xs">{inv.encf ?? '—'}</td>
                        <td className="px-4 py-2 text-xs">
                          <p>{inv.buyerName ?? '—'}</p>
                          {inv.buyerRnc && <p className="text-muted-foreground font-mono">{inv.buyerRnc}</p>}
                        </td>
                        <td className="px-4 py-2"><Badge variant="outline">{inv.ecfType}</Badge></td>
                        <td className="px-4 py-2">
                          <Badge variant={(STATUS_BADGE[inv.status] ?? 'secondary') as 'secondary'}>
                            {inv.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(inv.totalAmount)}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDateTime(inv.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          <InvoiceDetailDrawer
            invoiceId={selectedInvoiceId}
            onClose={() => setSelectedInvoiceId(null)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({
  label, error, children, className,
}: { label: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
