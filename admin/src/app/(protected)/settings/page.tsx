'use client';

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTheme } from 'next-themes';
import { Loader2, Sun, Moon, Monitor, Key, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/utils';
import type { Tenant, ApiKey } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

// ── types ──────────────────────────────────────────────────────────────────

interface TenantMe extends Tenant {
  apiKeys?: ApiKey[];
}

// ── account form ───────────────────────────────────────────────────────────

const accountSchema = z.object({
  name:  z.string().min(2, 'Mínimo 2 caracteres'),
  email: z.string().email('Email inválido'),
});
type AccountForm = z.infer<typeof accountSchema>;

async function fetchMe(): Promise<TenantMe> {
  const res = await apiClient.get<{ data: TenantMe }>('/tenants/me');
  return res.data.data;
}

async function patchMe(dto: AccountForm): Promise<TenantMe> {
  const res = await apiClient.patch<{ data: TenantMe }>('/tenants/me', dto);
  return res.data.data;
}

// ── copy helper ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Copiar"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();

  const { data: me, isLoading } = useQuery({
    queryKey: ['tenants', 'me'],
    queryFn: fetchMe,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<AccountForm>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(accountSchema) as any,
    defaultValues: { name: '', email: '' },
  });

  useEffect(() => {
    if (me) reset({ name: me.name, email: me.email });
  }, [me, reset]);

  const mutation = useMutation({
    mutationFn: patchMe,
    onSuccess: (updated) => {
      toast.success('Perfil actualizado');
      queryClient.setQueryData(['tenants', 'me'], updated);
      reset({ name: updated.name, email: updated.email });
    },
    onError: () => toast.error('Error al actualizar el perfil'),
  });

  const THEMES = [
    { value: 'light',  label: 'Claro',  icon: Sun },
    { value: 'dark',   label: 'Oscuro', icon: Moon },
    { value: 'system', label: 'Sistema',icon: Monitor },
  ] as const;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-1">Administra tu cuenta y preferencias</p>
      </div>

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Mi Cuenta</TabsTrigger>
          <TabsTrigger value="appearance">Apariencia</TabsTrigger>
          <TabsTrigger value="api">API Keys</TabsTrigger>
        </TabsList>

        {/* ── Mi Cuenta ─────────────────────────────────────────────────── */}
        <TabsContent value="account">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Información de la cuenta</CardTitle>
              <CardDescription>Actualiza el nombre y email de tu tenant.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  <div className="h-9 bg-muted animate-pulse rounded-md" />
                  <div className="h-9 bg-muted animate-pulse rounded-md" />
                </div>
              ) : (
                <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Nombre del tenant *</Label>
                    <Input id="name" {...register('name')} />
                    {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email *</Label>
                    <Input id="email" type="email" {...register('email')} />
                    {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Plan: <Badge variant="outline" className="ml-1">{me?.plan}</Badge></span>
                    <span>ID: <span className="font-mono">{me?.id}</span></span>
                  </div>

                  <div className="flex justify-end">
                    <Button type="submit" disabled={!isDirty || mutation.isPending}>
                      {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Guardar cambios
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Apariencia ────────────────────────────────────────────────── */}
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tema</CardTitle>
              <CardDescription>Elige cómo se muestra la interfaz.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                {THEMES.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors hover:bg-muted ${
                      theme === value ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── API Keys ──────────────────────────────────────────────────── */}
        <TabsContent value="api">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Key className="h-4 w-4" /> API Keys
              </CardTitle>
              <CardDescription>
                Tus claves de acceso. Gestionalas desde el panel de Tenants.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="px-4 py-6 space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="h-12 bg-muted animate-pulse rounded-md" />
                  ))}
                </div>
              ) : !me?.apiKeys?.length ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Sin API keys registradas</p>
              ) : (
                <ul className="divide-y">
                  {me.apiKeys.map((k) => (
                    <li key={k.id} className="flex items-center justify-between px-4 py-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{k.name}</span>
                          <Badge variant={k.isLive ? 'default' : 'secondary'} className="text-[10px]">
                            {k.isLive ? 'Live' : 'Test'}
                          </Badge>
                          <Badge variant={k.isActive ? 'success' : 'destructive'} className="text-[10px]">
                            {k.isActive ? 'Activa' : 'Revocada'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono">{k.keyPrefix}…</span>
                          <CopyButton text={k.keyPrefix} />
                          <span>·</span>
                          <span>{k.lastUsedAt ? `Último uso ${fmtDateTime(k.lastUsedAt)}` : 'Nunca usado'}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
