'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Loader2, Users, CheckCircle2, AlertTriangle, Copy, Check,
  CreditCard,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { useAuthStore } from '@/lib/auth-store';
import { fmtMoney } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { Plan, BillingPlan } from '@/types/api';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TenantPlanResult {
  id: string;
  status: string;
  planId: string;
}

interface AdminCreateResult {
  tenant: {
    id: string;
    name: string;
    email: string;
    plan: Plan;
    isActive: boolean;
    mustChangePassword: boolean;
    createdAt: string;
  };
  credentials: { email: string; temporaryPassword: string };
  apiKeys: {
    test: { key: string; prefix: string; scopes: string[] };
    live: { key: string; prefix: string; scopes: string[] };
  };
  tenantPlan?: TenantPlanResult;
}

// ── Form schema ────────────────────────────────────────────────────────────────

const schema = z.object({
  name:     z.string().min(3, 'Mínimo 3 caracteres').max(200),
  email:    z.string().email('Email inválido'),
  planCode: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

// ── Copy button ────────────────────────────────────────────────────────────────

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`text-sm truncate mt-0.5 ${mono ? 'font-mono' : 'font-medium'}`}>{value}</p>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={`Copiar ${label}`}
      >
        {copied
          ? <Check className="h-4 w-4 text-green-500" />
          : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

// ── Credentials screen ────────────────────────────────────────────────────────

function CredentialsScreen({
  result,
  selectedPlan,
  onConfirm,
}: {
  result: AdminCreateResult;
  selectedPlan: BillingPlan | undefined;
  onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Las credenciales del tenant no se mostrarán de nuevo. ¿Salir de todas formas?';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const { tenant, credentials, apiKeys, tenantPlan } = result;

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-background/95 backdrop-blur-sm">
      <div className="min-h-screen flex items-start justify-center p-4 py-8">
        <div className="w-full max-w-xl space-y-6">

          {/* Success banner */}
          <div className="flex items-center gap-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-4">
            <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
            <div>
              <p className="font-semibold text-green-800 dark:text-green-200">Tenant creado correctamente</p>
              <p className="text-sm text-green-700 dark:text-green-300 mt-0.5">
                {tenant.name} · {tenant.email}
              </p>
            </div>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-800 dark:text-amber-200">
                ⚠️ GUARDÁ ESTAS CREDENCIALES AHORA
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                La contraseña temporal y las API keys <strong>no se mostrarán de nuevo</strong>.
                El cliente deberá cambiar su contraseña en el primer login.
              </p>
            </div>
          </div>

          {/* Tenant info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Datos del tenant</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">ID:</span> <span className="font-mono text-xs">{tenant.id}</span></div>
                <div><span className="text-muted-foreground">Plan:</span> <Badge variant="outline" className="ml-1">{tenant.plan}</Badge></div>
              </div>
            </CardContent>
          </Card>

          {/* Plan asignado (si se creó TenantPlan) */}
          {tenantPlan && selectedPlan && (
            <Card className="border-amber-200 dark:border-amber-800">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-amber-600" />
                  Plan asignado
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{selectedPlan.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {fmtMoney(selectedPlan.monthlyFee, 'USD')}/mes · {selectedPlan.includedInvoices.toLocaleString()} facturas
                    </p>
                  </div>
                  <Badge variant="warning">Pendiente de pago</Badge>
                </div>
                <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                  Cuando el cliente realice el pago, andá a{' '}
                  <strong>Tenants → {tenant.name} → Plan y Billing</strong>{' '}
                  y activá el plan.
                </div>
              </CardContent>
            </Card>
          )}

          {/* Credentials */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Credenciales de acceso</CardTitle>
              <CardDescription>El cliente usa estas para el primer login</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <CopyField label="Email" value={credentials.email} mono={false} />
              <CopyField label="Contraseña temporal" value={credentials.temporaryPassword} />
            </CardContent>
          </Card>

          {/* API Keys */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">API Keys</CardTitle>
              <CardDescription>Para integración programática. Cada una se muestra una sola vez.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">TEST KEY</p>
                <CopyField label="Key completa" value={apiKeys.test.key} />
                <p className="text-xs text-muted-foreground mt-1">Prefix: {apiKeys.test.prefix}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">LIVE KEY</p>
                <CopyField label="Key completa" value={apiKeys.live.key} />
                <p className="text-xs text-muted-foreground mt-1">Prefix: {apiKeys.live.prefix}</p>
              </div>
            </CardContent>
          </Card>

          {/* Confirm */}
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 rounded"
              />
              <span className="text-sm">
                Confirmé que guardé la contraseña temporal y las API keys en un lugar seguro.
                Entiendo que no podré recuperarlos.
              </span>
            </label>
            <Button className="w-full" disabled={!confirmed} onClick={onConfirm}>
              Ir a la lista de Tenants
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewTenantPage() {
  const router = useRouter();
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const [result, setResult] = useState<AdminCreateResult | null>(null);
  const [selectedPlanCode, setSelectedPlanCode] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    if (isSuperAdmin === false) {
      toast.error('No tenés permiso para acceder a esa sección.');
      router.replace('/home');
    }
  }, [isSuperAdmin, router]);

  // Fetch billing plan catalog
  const { data: billingPlans } = useQuery({
    queryKey: ['admin', 'billing', 'plans'],
    queryFn: async () => {
      const res = await apiClient.get<{ data: BillingPlan[] }>('/admin/plans');
      return res.data.data;
    },
    enabled: isSuperAdmin === true,
  });

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema) as any,
  });

  const mutation = useMutation({
    mutationFn: async (dto: FormData) => {
      const payload: Record<string, string> = { name: dto.name, email: dto.email };
      if (dto.planCode && dto.planCode !== 'none') payload.planCode = dto.planCode;
      const res = await apiClient.post<{ data: AdminCreateResult }>('/admin/tenants', payload);
      return res.data.data;
    },
    onSuccess: (data, variables) => {
      const code = variables.planCode !== 'none' ? variables.planCode : undefined;
      setSelectedPlanCode(code);
      setResult(data);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? '';
      if (msg.toLowerCase().includes('email') || msg.toLowerCase().includes('already')) {
        setEmailError(msg || 'Este email ya está registrado');
      } else {
        toast.error(msg || 'Error al crear el tenant');
      }
    },
  });

  function handleConfirm() {
    setResult(null);
    router.push('/tenants');
  }

  const selectedPlan = billingPlans?.find((p) => p.code === selectedPlanCode);

  if (result) {
    return (
      <CredentialsScreen
        result={result}
        selectedPlan={selectedPlan}
        onConfirm={handleConfirm}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Nuevo Tenant</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            El backend genera la contraseña temporal automáticamente.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-5 w-5" /> Datos del tenant
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit((d) => { setEmailError(null); mutation.mutate(d); })}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>Nombre *</Label>
              <Input placeholder="Empresa Integradora SRL" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input
                type="email"
                placeholder="admin@empresa.com"
                {...register('email')}
                onChange={(e) => { setEmailError(null); register('email').onChange(e); }}
              />
              {(errors.email || emailError) && (
                <p className="text-xs text-destructive">{errors.email?.message ?? emailError}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Plan inicial (opcional)</Label>
              <Select
                defaultValue="none"
                onValueChange={(v) => setValue('planCode', v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sin plan (asignar después)" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">Sin plan (asignar después)</span>
                  </SelectItem>
                  {billingPlans?.map((p) => (
                    <SelectItem key={p.code} value={p.code}>
                      <span className="font-medium">{p.code}</span>
                      <span className="text-muted-foreground text-xs ml-2">
                        — {p.name} ({fmtMoney(p.monthlyFee, 'USD')}/mes, {p.includedInvoices.toLocaleString()} facturas)
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Si asignás un plan, quedará en estado "Pendiente de pago" hasta que lo activés manualmente.
              </p>
            </div>

            <div className="rounded-lg bg-muted/50 border border-border px-3 py-2 text-sm text-muted-foreground">
              La contraseña temporal es generada automáticamente por el backend.
              El cliente deberá cambiarla en su primer login.
            </div>

            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Crear Tenant
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
