'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, CreditCard, CheckCircle2, Clock, XCircle, AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDate, fmtMoney } from '@/lib/utils';
import type { TenantPlan, BillingPlan, TenantPlanStatus } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

// ── helpers ────────────────────────────────────────────────────────────────────

function daysLeft(expiresAt: string | undefined): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000));
}

function statusBadge(status: TenantPlanStatus) {
  const map: Record<TenantPlanStatus, { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
    ACTIVE:           { label: 'Activo',             variant: 'success' },
    PENDING_PAYMENT:  { label: 'Pendiente de pago',  variant: 'warning' },
    EXPIRED:          { label: 'Vencido',             variant: 'destructive' },
    CANCELED:         { label: 'Cancelado',           variant: 'secondary' },
  };
  const { label, variant } = map[status] ?? { label: status, variant: 'secondary' as const };
  return <Badge variant={variant}>{label}</Badge>;
}

// ── active plan card ───────────────────────────────────────────────────────────

function ActivePlanCard({
  tenantPlan,
  onCancel,
}: {
  tenantPlan: TenantPlan;
  onCancel: () => void;
}) {
  const used = tenantPlan.monthlyUsage?.invoicesCount ?? 0;
  const limit = tenantPlan.plan.includedInvoices;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const days = daysLeft(tenantPlan.expiresAt);
  const nearLimit = pct >= 80;

  return (
    <Card className="border-green-200 dark:border-green-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
            Plan Activo
          </CardTitle>
          {statusBadge('ACTIVE')}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-semibold text-lg">{tenantPlan.plan.name}</p>
          <p className="text-sm text-muted-foreground">
            {fmtMoney(tenantPlan.plan.monthlyFee, 'USD')}/mes
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Facturas usadas</span>
            <span className={nearLimit ? 'text-amber-600 font-medium' : ''}>
              {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
            </span>
          </div>
          <Progress
            value={pct}
            indicatorClassName={pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-amber-500' : 'bg-green-500'}
          />
          {nearLimit && (
            <p className="text-xs text-amber-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Cerca del límite del plan
            </p>
          )}
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Vence</span>
          <span className={days <= 7 ? 'text-amber-600 font-medium' : ''}>
            {fmtDate(tenantPlan.expiresAt)} ({days} días)
          </span>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Activado: {fmtDate(tenantPlan.activatedAt)}</span>
        </div>

        <Button variant="destructive" size="sm" onClick={onCancel}>
          Cancelar plan
        </Button>
      </CardContent>
    </Card>
  );
}

// ── pending payment card ───────────────────────────────────────────────────────

function PendingPaymentCard({
  tenantPlan,
  onActivate,
  onCancel,
}: {
  tenantPlan: TenantPlan;
  onActivate: () => void;
  onCancel: () => void;
}) {
  return (
    <Card className="border-amber-200 dark:border-amber-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            Pendiente de pago
          </CardTitle>
          {statusBadge('PENDING_PAYMENT')}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-semibold text-lg">{tenantPlan.plan.name}</p>
          <p className="text-sm text-muted-foreground">
            {fmtMoney(tenantPlan.plan.monthlyFee, 'USD')}/mes · {tenantPlan.plan.includedInvoices.toLocaleString()} facturas
          </p>
        </div>

        <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          El cliente todavía no realizó el pago. Cuando lo confirme, hacé click en <strong>Activar</strong>.
        </div>

        <div className="flex gap-2">
          <Button size="sm" onClick={onActivate} className="flex-1">
            Activar plan
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── expired / no plan card ─────────────────────────────────────────────────────

function InactivePlanCard({
  tenantPlan,
  onAssign,
}: {
  tenantPlan?: TenantPlan;
  onAssign: () => void;
}) {
  if (!tenantPlan) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 flex flex-col items-center gap-3 text-center">
          <CreditCard className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">Sin plan asignado</p>
            <p className="text-sm text-muted-foreground mt-1">
              Este tenant no puede emitir facturas hasta que se le asigne un plan.
            </p>
          </div>
          <Button onClick={onAssign} className="gap-2">
            <Plus className="h-4 w-4" /> Asignar plan
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-muted">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <XCircle className="h-5 w-5 text-muted-foreground" />
            Plan {tenantPlan.status === 'EXPIRED' ? 'vencido' : 'cancelado'}
          </CardTitle>
          {statusBadge(tenantPlan.status)}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-semibold">{tenantPlan.plan.name}</p>
          {tenantPlan.status === 'EXPIRED' && (
            <p className="text-sm text-muted-foreground">
              Venció el {fmtDate(tenantPlan.expiresAt)}
            </p>
          )}
        </div>
        <Button onClick={onAssign} className="gap-2">
          <Plus className="h-4 w-4" /> Asignar nuevo plan
        </Button>
      </CardContent>
    </Card>
  );
}

// ── assign dialog ──────────────────────────────────────────────────────────────

function AssignPlanDialog({
  open,
  tenantId,
  billingPlans,
  onClose,
}: {
  open: boolean;
  tenantId: string;
  billingPlans: BillingPlan[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [planCode, setPlanCode] = useState('');
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      apiClient.post('/admin/plans/assign', { tenantId, planCode, notes: notes || undefined }),
    onSuccess: () => {
      toast.success('Plan asignado correctamente');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'plans'] });
      setPlanCode('');
      setNotes('');
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message;
      toast.error(msg ?? 'Error al asignar el plan');
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Asignar plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planCode} onValueChange={setPlanCode}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccioná un plan..." />
              </SelectTrigger>
              <SelectContent position="popper">
                {billingPlans.map((p) => (
                  <SelectItem key={p.code} value={p.code}>
                    <span className="font-medium">{p.code}</span>
                    <span className="text-muted-foreground text-xs ml-2">
                      — {p.name} ({fmtMoney(p.monthlyFee, 'USD')}/mes)
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Notas (opcional)</Label>
            <Textarea
              placeholder="Ej: Pago confirmado por transferencia 06/05/2026"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!planCode || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Asignar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── confirm dialog ─────────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmVariant = 'default',
  isPending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: 'default' | 'destructive';
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-2">{message}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isPending}>Cancelar</Button>
          <Button variant={confirmVariant} disabled={isPending} onClick={onConfirm}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export function BillingTab({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    type: 'activate' | 'cancel';
    tenantPlanId: string;
    planName: string;
  } | null>(null);

  const { data: history, isLoading } = useQuery({
    queryKey: ['admin', 'tenants', tenantId, 'plans'],
    queryFn: async () => {
      const res = await apiClient.get<{ data: TenantPlan[] }>(`/admin/tenants/${tenantId}/plans`);
      return res.data.data;
    },
  });

  const { data: billingPlans = [] } = useQuery({
    queryKey: ['admin', 'billing', 'plans'],
    queryFn: async () => {
      const res = await apiClient.get<{ data: BillingPlan[] }>('/admin/plans');
      return res.data.data;
    },
  });

  const activateMutation = useMutation({
    mutationFn: (tenantPlanId: string) =>
      apiClient.post(`/admin/plans/${tenantPlanId}/activate`),
    onSuccess: () => {
      toast.success('Plan activado. El tenant puede emitir facturas.');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'plans'] });
      setConfirmState(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message;
      toast.error(msg ?? 'Error al activar el plan');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (tenantPlanId: string) =>
      apiClient.post(`/admin/plans/${tenantPlanId}/cancel`),
    onSuccess: () => {
      toast.success('Plan cancelado');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId, 'plans'] });
      setConfirmState(null);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message;
      toast.error(msg ?? 'Error al cancelar el plan');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  // Most recent plan is first (backend sorts DESC)
  const current = history?.[0];
  const now = new Date();
  const isReallyActive =
    current?.status === 'ACTIVE' &&
    current.expiresAt &&
    new Date(current.expiresAt) > now;

  function openActivate(tp: TenantPlan) {
    setConfirmState({ type: 'activate', tenantPlanId: tp.id, planName: tp.plan.name });
  }

  function openCancel(tp: TenantPlan) {
    setConfirmState({ type: 'cancel', tenantPlanId: tp.id, planName: tp.plan.name });
  }

  return (
    <div className="space-y-6">
      {/* SECCIÓN A — Plan actual */}
      {isReallyActive && current ? (
        <ActivePlanCard tenantPlan={current} onCancel={() => openCancel(current)} />
      ) : current?.status === 'PENDING_PAYMENT' ? (
        <PendingPaymentCard
          tenantPlan={current}
          onActivate={() => openActivate(current)}
          onCancel={() => openCancel(current)}
        />
      ) : (
        <InactivePlanCard
          tenantPlan={current}
          onAssign={() => setAssignOpen(true)}
        />
      )}

      {/* SECCIÓN C — Historial */}
      {(history?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">
              Historial de planes
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Plan', 'Estado', 'Activado', 'Vence', 'Notas'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history?.slice(0, 10).map((tp) => (
                  <tr key={tp.id} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-medium text-xs">{tp.plan.code}</span>
                      <span className="text-muted-foreground text-xs ml-1">— {tp.plan.name}</span>
                    </td>
                    <td className="px-4 py-2">{statusBadge(tp.status)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDate(tp.activatedAt)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDate(tp.expiresAt)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-xs truncate">{tp.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      <AssignPlanDialog
        open={assignOpen}
        tenantId={tenantId}
        billingPlans={billingPlans}
        onClose={() => setAssignOpen(false)}
      />

      <ConfirmDialog
        open={confirmState?.type === 'activate'}
        title="Activar plan"
        message={`Vas a activar el plan ${confirmState?.planName ?? ''}. El plan estará vigente por 30 días desde ahora. ¿Confirmás?`}
        confirmLabel="Activar"
        isPending={activateMutation.isPending}
        onConfirm={() => confirmState && activateMutation.mutate(confirmState.tenantPlanId)}
        onCancel={() => setConfirmState(null)}
      />

      <ConfirmDialog
        open={confirmState?.type === 'cancel'}
        title="Cancelar plan"
        message={`Vas a cancelar el plan ${confirmState?.planName ?? ''}. El tenant no podrá emitir facturas hasta que se asigne uno nuevo. ¿Confirmás?`}
        confirmLabel="Cancelar plan"
        confirmVariant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => confirmState && cancelMutation.mutate(confirmState.tenantPlanId)}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
