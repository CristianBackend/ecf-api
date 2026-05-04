'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Plus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { fmtDate } from '@/lib/utils';
import { useAuthStore } from '@/lib/auth-store';
import type { Company, Certificate } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CertificateUploadDialog } from '@/components/tenants/certificate-upload-dialog';

interface CertWithCompany extends Certificate {
  companyName: string;
  companyRnc: string;
}

async function fetchAllCerts(): Promise<{ companies: Company[]; certs: CertWithCompany[] }> {
  const companiesRes = await apiClient.get<{ data: Company[] }>('/companies');
  const companies: Company[] = companiesRes.data.data;

  const certResults = await Promise.all(
    companies.map(async (c) => {
      try {
        const res = await apiClient.get<{ data: Certificate[] }>(`/companies/${c.id}/certificates`);
        return (res.data.data ?? []).map((cert) => ({
          ...cert,
          companyName: c.businessName,
          companyRnc: c.rnc,
        }));
      } catch {
        return [];
      }
    }),
  );

  return {
    companies,
    certs: certResults.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  };
}

export default function CertificatesPage() {
  const queryClient = useQueryClient();
  const { tenant } = useAuthStore();
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['my', 'certificates'],
    queryFn: fetchAllCerts,
  });

  const companies = data?.companies ?? [];
  const certs = data?.certs ?? [];

  function handleUploadSuccess() {
    void queryClient.invalidateQueries({ queryKey: ['my', 'certificates'] });
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Mis Certificados</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Certificados digitales (.p12) de firma electrónica
          </p>
        </div>
        {companies.length > 0 && (
          <Button className="gap-2" onClick={() => setUploadOpen(true)}>
            <Plus className="h-4 w-4" /> Subir Certificado
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-5 w-5" /> Certificados
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y px-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="py-4"><Skeleton className="h-12" /></div>
              ))}
            </div>
          ) : certs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Shield className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {companies.length === 0
                  ? 'Primero registrá una empresa para poder subir certificados.'
                  : 'No hay certificados subidos todavía.'}
              </p>
              {companies.length > 0 && (
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Subir primer certificado
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {certs.map((cert) => {
                const daysLeft = Math.ceil(
                  (new Date(cert.validTo).getTime() - Date.now()) / 86400000,
                );
                const expired = daysLeft < 0;
                const expiringSoon = !expired && daysLeft <= 30;

                return (
                  <div key={cert.id} className="flex items-center justify-between px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={cert.isActive ? 'success' : 'secondary'}>
                          {cert.isActive ? 'Activo' : 'Inactivo'}
                        </Badge>
                        {expired && <Badge variant="destructive">Vencido</Badge>}
                        {expiringSoon && (
                          <Badge variant="warning">Vence en {daysLeft}d</Badge>
                        )}
                        <span className="text-xs font-medium">{cert.companyName}</span>
                        <span className="text-xs text-muted-foreground font-mono">{cert.companyRnc}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {cert.signerName ?? 'Firmante desconocido'} · Válido hasta{' '}
                        {fmtDate(cert.validTo)}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0 ml-4">
                      {fmtDate(cert.createdAt)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {companies.length > 0 && (
        <CertificateUploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          companies={companies}
          tenantId={tenant?.id ?? ''}
          onSuccess={handleUploadSuccess}
        />
      )}
    </div>
  );
}
