'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Key } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ApiKeyRevealModal } from './api-key-reveal-modal';

const ALL_SCOPES_WITH_ADMIN = [
  'INVOICES_READ', 'INVOICES_WRITE', 'COMPANIES_READ', 'COMPANIES_WRITE',
  'CERTIFICATES_WRITE', 'SEQUENCES_READ', 'WEBHOOKS_MANAGE', 'ADMIN', 'FULL_ACCESS',
] as const;

const ALL_SCOPES_NO_ADMIN = [
  'INVOICES_READ', 'INVOICES_WRITE', 'COMPANIES_READ', 'COMPANIES_WRITE',
  'CERTIFICATES_WRITE', 'SEQUENCES_READ', 'WEBHOOKS_MANAGE', 'FULL_ACCESS',
] as const;

type Scope = typeof ALL_SCOPES_WITH_ADMIN[number];

const schema = z.object({
  name:    z.string().min(2, 'Mínimo 2 caracteres'),
  isLive:  z.boolean(),
  scopes:  z.array(z.enum(ALL_SCOPES_WITH_ADMIN)).min(1, 'Seleccioná al menos un scope'),
});

type FormData = z.infer<typeof schema>;

interface CreateApiKeyResponse {
  id: string;
  name: string;
  key: string;
  isLive: boolean;
  scopes: Scope[];
}

async function createApiKey(data: FormData): Promise<CreateApiKeyResponse> {
  const res = await apiClient.post<{ data: CreateApiKeyResponse }>('/auth/keys', data);
  return res.data.data;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  /** When false (default for tenant-normal users), ADMIN scope is hidden. */
  allowAdminScope?: boolean;
}

export function CreateApiKeyDialog({ open, onOpenChange, onCreated, allowAdminScope = true }: Props) {
  const SCOPES = allowAdminScope ? ALL_SCOPES_WITH_ADMIN : ALL_SCOPES_NO_ADMIN;
  const [revealKey, setRevealKey] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema) as any,
    defaultValues: { name: '', isLive: false, scopes: ['FULL_ACCESS'] },
  });

  const selectedScopes = watch('scopes');
  const isLive = watch('isLive');

  function toggleScope(scope: Scope) {
    if (scope === 'FULL_ACCESS') {
      setValue('scopes', selectedScopes.includes('FULL_ACCESS') ? [] : ['FULL_ACCESS']);
      return;
    }
    const without = selectedScopes.filter((s) => s !== scope && s !== 'FULL_ACCESS');
    const has = selectedScopes.includes(scope);
    setValue('scopes', has ? without : [...without, scope]);
  }

  const mutation = useMutation({
    mutationFn: createApiKey,
    onSuccess: (data) => {
      setRevealKey(data.key);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Error al crear la API key';
      toast.error(msg);
    },
  });

  function handleRevealConfirm() {
    setRevealKey(null);
    reset();
    toast.success('API key creada exitosamente');
    onOpenChange(false);
    onCreated?.();
  }

  return (
    <>
      <Dialog open={open && !revealKey} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Key className="h-5 w-5" /> Nueva API Key</DialogTitle>
            <DialogDescription>Se crea para el tenant actualmente autenticado.</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nombre *</Label>
              <Input placeholder="Ej: ERP Producción, Integración Odoo" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Modo producción (Live)</p>
                <p className="text-xs text-muted-foreground">Desactivado = Test key</p>
              </div>
              <Switch checked={isLive} onCheckedChange={(v) => setValue('isLive', v)} />
            </div>

            <div className="space-y-2">
              <Label>Scopes *</Label>
              <div className="flex flex-wrap gap-2 rounded-lg border p-3">
                {SCOPES.map((scope) => {
                  const active = selectedScopes.includes(scope);
                  return (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => toggleScope(scope)}
                      className="focus:outline-none"
                    >
                      <Badge
                        variant={active ? 'default' : 'outline'}
                        className="cursor-pointer hover:opacity-80 text-xs"
                      >
                        {scope}
                      </Badge>
                    </button>
                  );
                })}
              </div>
              {errors.scopes && <p className="text-xs text-destructive">{errors.scopes.message}</p>}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generar API Key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ApiKeyRevealModal
        open={!!revealKey}
        keys={isLive ? { live: revealKey ?? undefined } : { test: revealKey ?? undefined }}
        onConfirm={handleRevealConfirm}
      />
    </>
  );
}
