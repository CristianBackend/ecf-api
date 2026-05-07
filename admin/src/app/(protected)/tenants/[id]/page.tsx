'use client';

import { use, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Key, Webhook, FileText, Shield, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/utils';
import type { TenantDetail, Company } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CertificateUploadDialog } from '@/components/tenants/certificate-upload-dialog';
import { CreateApiKeyDialog } from '@/components/tenants/create-api-key-dialog';
import { BillingTab } from '@/components/tenants/billing-tab';

async function fetchTenant(id: string): Promise<TenantDetail> {
  const res = await apiClient.get<{ data: TenantDetail }>('/admin/tenants/' + id);
  return res.data.data;
}

export default function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [certUploadOpen, setCertUploadOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', id],
    queryFn: () => fetchTenant(id),
  });

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      </div>
    );
  }

  if (!data) return null;

  async function revokeKey(keyId: string) {
    if (!confirm('¿Revocar esta API key? Esta acción no se puede deshacer.')) return;
    try {
      await apiClient.delete('/auth/keys/' + keyId);
      toast.success('API key revocada');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', id] });
    } catch {
      toast.error('Error al revocar la key');
    }
  }

  const allCerts = data.companies?.flatMap((c) =>
    (c.certificates ?? []).map((cert) => ({ ...cert, companyName: c.businessName }))
  ) ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{data.name}</h1>
            <Badge variant={data.isActive ? 'success' : 'secondary'}>{data.isActive ? 'Activo' : 'Inactivo'}</Badge>
            <Badge variant="outline">{data.plan}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{data.email} · <span className="font-mono text-xs">{data.id}</span></p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Empresas', value: data.companies?.length ?? 0, icon: Building2 },
          { label: 'API Keys', value: data.apiKeys?.length ?? 0, icon: Key },
          { label: 'Webhooks', value: data.webhooks?.length ?? 0, icon: Webhook },
          { label: 'Facturas totales', value: data.metrics?.invoiceTotal ?? 0, icon: FileText },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-xl font-bold">{fmtNumber(value)}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="companies">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="companies">Empresas</TabsTrigger>
          <TabsTrigger value="certificates">Certificados</TabsTrigger>
          <TabsTrigger value="apikeys">API Keys</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="billing">Plan y Billing</TabsTrigger>
        </TabsList>

        <TabsContent value="companies">
          <Card><CardContent className="p-0">
            {!data.companies?.length ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Sin empresas registradas</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/50">
                  {['RNC', 'Razón Social', 'Ambiente', 'Estado', 'Creado'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {data.companies?.map((c) => (
                    <tr key={c.id} className="border-b">
                      <td className="px-4 py-2 font-mono text-xs">{c.rnc}</td>
                      <td className="px-4 py-2">{c.businessName}</td>
                      <td className="px-4 py-2"><Badge variant="outline">{c.dgiiEnv}</Badge></td>
                      <td className="px-4 py-2"><Badge variant={c.isActive ? 'success' : 'secondary'}>{c.isActive ? 'Activa' : 'Inactiva'}</Badge></td>
                      <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="certificates">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex gap-2"><Shield className="h-5 w-5" /> Certificados</CardTitle>
              {(data.companies?.length ?? 0) > 0 && (
                <Button size="sm" className="gap-2" onClick={() => setCertUploadOpen(true)}>
                  <Plus className="h-4 w-4" /> Subir Certificado
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {allCerts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin certificados subidos</p>
              ) : allCerts.map((cert) => {
                const daysLeft = Math.ceil((new Date(cert.validTo).getTime() - Date.now()) / 86400000);
                const expired = daysLeft < 0;
                const expiringSoon = !expired && daysLeft <= 30;
                return (
                  <div key={cert.id} className="flex items-center justify-between px-4 py-3 border-b last:border-0">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={cert.isActive ? 'success' : 'secondary'}>{cert.isActive ? 'Activo' : 'Inactivo'}</Badge>
                        {expired && <Badge variant="destructive">Vencido</Badge>}
                        {expiringSoon && <Badge variant="warning">Vence en {daysLeft}d</Badge>}
                        <span className="text-xs text-muted-foreground">{cert.companyName}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {cert.signerName ?? 'Firmante desconocido'} · Válido hasta {fmtDate(cert.validTo)}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0 ml-4">{fmtDate(cert.createdAt)}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>
          {(data.companies?.length ?? 0) > 0 && (
            <CertificateUploadDialog
              open={certUploadOpen}
              onOpenChange={setCertUploadOpen}
              companies={data.companies as Company[]}
              tenantId={id}
            />
          )}
        </TabsContent>

        <TabsContent value="apikeys">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex gap-2"><Key className="h-5 w-5" /> API Keys</CardTitle>
              <Button size="sm" className="gap-2" onClick={() => setCreateKeyOpen(true)}>
                <Plus className="h-4 w-4" /> Nueva API Key
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {!data.apiKeys?.length ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin API keys</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b bg-muted/50">
                    {['Nombre', 'Prefijo', 'Tipo', 'Estado', 'Último uso', ''].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {data.apiKeys?.map((k) => (
                      <tr key={k.id} className="border-b">
                        <td className="px-4 py-2 font-medium">{k.name}</td>
                        <td className="px-4 py-2 font-mono text-xs">{k.keyPrefix}…</td>
                        <td className="px-4 py-2"><Badge variant={k.isLive ? 'default' : 'secondary'}>{k.isLive ? 'Live' : 'Test'}</Badge></td>
                        <td className="px-4 py-2"><Badge variant={k.isActive ? 'success' : 'destructive'}>{k.isActive ? 'Activa' : 'Revocada'}</Badge></td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '—'}</td>
                        <td className="px-4 py-2">
                          {k.isActive && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => revokeKey(k.id)}>
                              <Trash2 className="h-3 w-3 mr-1" /> Revocar
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          <CreateApiKeyDialog
            open={createKeyOpen}
            onOpenChange={setCreateKeyOpen}
            onCreated={() => { void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', id] }); }}
          />
        </TabsContent>

        <TabsContent value="webhooks">
          <Card>
            <CardHeader><CardTitle className="text-base flex gap-2"><Webhook className="h-5 w-5" /> Webhooks</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!data.webhooks?.length ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin webhooks configurados</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b bg-muted/50">
                    {['URL', 'Eventos', 'Estado'].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {data.webhooks?.map((w) => (
                      <tr key={w.id} className="border-b">
                        <td className="px-4 py-2 font-mono text-xs max-w-xs truncate">{w.url}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {w.events.slice(0, 3).join(', ')}{w.events.length > 3 ? ` +${w.events.length - 3}` : ''}
                        </td>
                        <td className="px-4 py-2"><Badge variant={w.isActive ? 'success' : 'secondary'}>{w.isActive ? 'Activo' : 'Inactivo'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="billing">
          <BillingTab tenantId={id} />
        </TabsContent>
      </Tabs>

      <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <span>Creado: {fmtDateTime(data.createdAt)}</span>
        <span>Actualizado: {fmtDateTime(data.updatedAt)}</span>
        <span>Facturas este mes: {fmtNumber(data.metrics?.invoiceThisMonth)}</span>
      </div>
    </div>
  );
}
