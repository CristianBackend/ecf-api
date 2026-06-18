'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTheme } from 'next-themes';
import {
  Loader2, Sun, Moon, Monitor, Key, Copy, Check,
  CreditCard, CheckCircle2, Clock, AlertTriangle, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime, fmtDate } from '@/lib/utils';
import type { Tenant, ApiKey, TenantUsage, TenantPlan } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

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

async function fetchUsage(): Promise<TenantUsage> {
  const res = await apiClient.get<{ data: TenantUsage }>('/tenants/me/usage');
  return res.data.data;
}

async function fetchPlanHistory(): Promise<TenantPlan[]> {
  // Get tenantId from /tenants/me and then the plan history from the backend.
  // Since there's no GET /tenants/me/plans endpoint, we use the usage endpoint
  // for current status and show limited history info.
  // TODO: add GET /tenants/me/plans endpoint to backend for full history.
  return [];
}
void fetchPlanHistory; // suppress unused warning

function PlanStatusIcon({ status }: { status: string }) {
  if (status === 'ACTIVE') return <CheckCircle2 className="h-5 w-5 text-green-500" />;
  if (status === 'PENDING_PAYMENT') return <Clock className="h-5 w-5 text-amber-500" />;
  if (status === 'EXPIRED') return <AlertTriangle className="h-5 w-5 text-destructive" />;
  return <XCircle className="h-5 w-5 text-muted-foreground" />;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') === 'plan' ? 'plan' : 'account';

  const { data: me, isLoading } = useQuery({
    queryKey: ['tenants', 'me'],
    queryFn: fetchMe,
  });

  const { data: usageData, isLoading: usageLoading } = useQuery({
    queryKey: ['my', 'usage'],
    queryFn: fetchUsage,
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-1">Administra tu cuenta y preferencias</p>
      </div>

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="account">Mi Cuenta</TabsTrigger>
          <TabsTrigger value="appearance">Apariencia</TabsTrigger>
          <TabsTrigger value="api">API Keys</TabsTrigger>
          <TabsTrigger value="plan">Mi Plan</TabsTrigger>
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
                Tus claves de acceso. Gestioná tus API keys desde <a href="/api-keys" className="underline">Mis API Keys</a>.
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

        {/* ── Mi Plan ───────────────────────────────────────────────────── */}
        <TabsContent value="plan">
          {usageLoading ? (
            <Card><CardContent className="pt-6 space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-32" />
            </CardContent></Card>
          ) : !usageData ? null : 'isExemptFromBilling' in usageData && usageData.isExemptFromBilling ? (
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                    <CreditCard className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-semibold">Cuenta de administrador</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Tu cuenta es de administrador. No estás sujeto a límites de facturación.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (() => {
            const typed = usageData as Exclude<TenantUsage, { isExemptFromBilling: true }>;
            const { hasActivePlan, plan, usage: u, status } = typed;
            return (
              <div className="space-y-4">
                {/* Current plan status */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2">
                        <PlanStatusIcon status={status ?? 'NO_PLAN'} />
                        Mi Plan
                      </CardTitle>
                      {status && status !== 'NO_PLAN' && (() => {
                        const map: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
                          ACTIVE: { label: 'Activo', variant: 'success' },
                          PENDING_PAYMENT: { label: 'Pendiente de pago', variant: 'warning' },
                          EXPIRED: { label: 'Vencido', variant: 'destructive' },
                          CANCELED: { label: 'Cancelado', variant: 'secondary' },
                        };
                        const s = map[status];
                        return s ? <Badge variant={s.variant}>{s.label}</Badge> : null;
                      })()}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!hasActivePlan && status === 'NO_PLAN' ? (
                      <p className="text-sm text-muted-foreground">
                        No tenés un plan asignado. Contactá al administrador del sistema.
                      </p>
                    ) : !hasActivePlan && status === 'PENDING_PAYMENT' && plan ? (
                      <div className="space-y-2">
                        <p className="font-semibold">{plan.name}</p>
                        <p className="text-sm text-muted-foreground">
                          Tu plan está pendiente de pago. Una vez que lo confirmes con el administrador, quedará activo.
                        </p>
                      </div>
                    ) : !hasActivePlan && status === 'EXPIRED' ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          Tu plan ha vencido. Contactá al administrador para renovarlo.
                        </p>
                        {u?.periodEnd && (
                          <p className="text-xs text-muted-foreground">Venció el {fmtDate(u.periodEnd)}</p>
                        )}
                      </div>
                    ) : plan && u ? (
                      <div className="space-y-4">
                        <div>
                          <p className="font-semibold text-lg">{plan.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {plan.includedInvoices.toLocaleString()} facturas por período · ${plan.monthlyFee}/mes
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Uso del período</span>
                            <span className={u.percentage >= 80 ? 'text-amber-600 font-medium' : ''}>
                              {u.current.toLocaleString()} / {u.limit.toLocaleString()} ({u.percentage}%)
                            </span>
                          </div>
                          <Progress
                            value={u.percentage}
                            indicatorClassName={
                              u.percentage >= 100 ? 'bg-destructive'
                                : u.percentage >= 80 ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            {u.remaining.toLocaleString()} facturas restantes
                          </p>
                        </div>
                        <Separator />
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <p className="text-muted-foreground">Inicio del período</p>
                            <p className="font-medium">{fmtDate(u.periodStart)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Fin del período</p>
                            <p className="font-medium">{fmtDate(u.periodEnd)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Días restantes</p>
                            <p className={`font-medium ${u.daysRemaining <= 7 ? 'text-amber-600' : ''}`}>
                              {u.daysRemaining} días
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card className="border-muted">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-sm text-muted-foreground text-center">
                      Para upgradear, renovar o modificar tu plan, contactá al administrador del sistema.
                    </p>
                  </CardContent>
                </Card>
              </div>
            );
          })()}
        </TabsContent>
      </Tabs>
    </div>
  );
}