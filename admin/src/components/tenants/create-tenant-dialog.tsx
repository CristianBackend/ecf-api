'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiKeyRevealModal } from './api-key-reveal-modal';

const schema = z.object({
  name:     z.string().min(2, 'Mínimo 2 caracteres'),
  email:    z.string().email('Email inválido'),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  plan:     z.enum(['STARTER', 'BUSINESS', 'ENTERPRISE', 'PLATFORM']),
});

type FormData = z.infer<typeof schema>;

interface CreateTenantResponse {
  id: string;
  name: string;
  testApiKey?: string;
  liveApiKey?: string;
}

async function createTenant(data: FormData): Promise<CreateTenantResponse> {
  const res = await apiClient.post<{ data: CreateTenantResponse }>('/tenants/register', data);
  return res.data.data;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTenantDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const [revealKeys, setRevealKeys] = useState<{ test?: string; live?: string } | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  // zodResolver v3 type inference issue with optional enum defaults — cast needed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = useForm<FormData>({ resolver: zodResolver(schema) as any, defaultValues: { plan: 'STARTER' } });

  const mutation = useMutation({
    mutationFn: createTenant,
    onSuccess: (data) => {
      reset();
      if (data.testApiKey || data.liveApiKey) {
        setRevealKeys({ test: data.testApiKey, live: data.liveApiKey });
      } else {
        toast.success('Tenant creado exitosamente');
        onOpenChange(false);
        void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Error al crear el tenant';
      toast.error(msg);
    },
  });

  function handleRevealConfirm() {
    setRevealKeys(null);
    toast.success('Tenant creado exitosamente');
    onOpenChange(false);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
  }

  return (
    <>
      <Dialog open={open && !revealKeys} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nuevo Tenant</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nombre *</Label>
              <Input placeholder="Mi Empresa Integradora" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input type="email" placeholder="admin@empresa.com" {...register('email')} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Contraseña *</Label>
              <Input type="password" placeholder="Mínimo 8 caracteres" {...register('password')} />
              {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Plan</Label>
              <Select defaultValue="STARTER" onValueChange={(v) => setValue('plan', v as FormData['plan'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['STARTER', 'BUSINESS', 'ENTERPRISE', 'PLATFORM'] as const).map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button type="submit" disabled={isSubmitting || mutation.isPending}>
                {(isSubmitting || mutation.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Crear Tenant
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ApiKeyRevealModal open={!!revealKeys} keys={revealKeys} onConfirm={handleRevealConfirm} />
    </>
  );
}
