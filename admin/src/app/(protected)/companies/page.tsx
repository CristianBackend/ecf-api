'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, ChevronRight, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDate } from '@/lib/utils';
import type { Company } from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const createSchema = z.object({
  rnc:          z.string().regex(/^\d{9}$|^\d{11}$/, 'RNC debe tener 9 o 11 dígitos'),
  businessName: z.string().min(2, 'Mínimo 2 caracteres').max(250),
  tradeName:    z.string().max(250).optional(),
  dgiiEnv:      z.enum(['DEV', 'CERT', 'PROD']).default('DEV'),
});

type CreateForm = z.infer<typeof createSchema>;

async function fetchCompanies(): Promise<Company[]> {
  const res = await apiClient.get<{ data: Company[] }>('/companies');
  return res.data.data;
}

async function createCompany(dto: CreateForm): Promise<Company> {
  const res = await apiClient.post<{ data: Company }>('/companies', dto);
  return res.data.data;
}

const ENV_LABELS: Record<string, string> = { DEV: 'Desarrollo', CERT: 'Certificación', PROD: 'Producción' };
const ENV_VARIANT: Record<string, string> = { DEV: 'secondary', CERT: 'warning', PROD: 'success' };

export default function CompaniesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['my', 'companies'],
    queryFn: fetchCompanies,
  });

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<CreateForm>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createSchema) as any,
    defaultValues: { dgiiEnv: 'DEV' },
  });

  const mutation = useMutation({
    mutationFn: createCompany,
    onSuccess: () => {
      toast.success('Empresa creada exitosamente');
      setCreateOpen(false);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['my', 'companies'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Error al crear la empresa';
      toast.error(msg);
    },
  });

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Mis Empresas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {companies.length} empresa{companies.length !== 1 ? 's' : ''} registrada{companies.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button className="gap-2" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> Nueva Empresa
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : companies.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Building2 className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Todavía no registraste ninguna empresa.</p>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Crear primera empresa
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Razón Social', 'RNC', 'Ambiente', 'Estado', 'Creado', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => router.push(`/companies/${c.id}`)}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.businessName}</p>
                      {c.tradeName && <p className="text-xs text-muted-foreground">{c.tradeName}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{c.rnc}</td>
                    <td className="px-4 py-3">
                      <Badge variant={(ENV_VARIANT[c.dgiiEnv] ?? 'secondary') as 'secondary'}>
                        {ENV_LABELS[c.dgiiEnv] ?? c.dgiiEnv}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.isActive ? 'success' : 'secondary'}>
                        {c.isActive ? 'Activa' : 'Inactiva'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(c.createdAt)}</td>
                    <td className="px-4 py-3">
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Create company dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) reset(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" /> Nueva Empresa
            </DialogTitle>
            <DialogDescription>
              Registrá una empresa. El RNC se valida contra el padrón DGII automáticamente.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
            <div className="space-y-1.5">
              <Label>RNC *</Label>
              <Input placeholder="130000001" {...register('rnc')} />
              {errors.rnc && <p className="text-xs text-destructive">{errors.rnc.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Razón Social *</Label>
              <Input placeholder="Empresa Ejemplo SRL" {...register('businessName')} />
              {errors.businessName && <p className="text-xs text-destructive">{errors.businessName.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Nombre Comercial (opcional)</Label>
              <Input placeholder="Ejemplo SRL" {...register('tradeName')} />
            </div>
            <div className="space-y-1.5">
              <Label>Ambiente DGII</Label>
              <Select defaultValue="DEV" onValueChange={(v) => setValue('dgiiEnv', v as 'DEV' | 'CERT' | 'PROD')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="DEV">Desarrollo</SelectItem>
                  <SelectItem value="CERT">Certificación</SelectItem>
                  <SelectItem value="PROD">Producción</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Crear Empresa
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
