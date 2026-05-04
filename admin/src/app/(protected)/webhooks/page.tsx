'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Plus, Webhook, Pencil, Trash2, Loader2, CheckCircle2, XCircle, Copy, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/utils';
import type { WebhookSubscription, WebhookCreated, WebhookDelivery } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';

// ── Event catalogue ────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = [
  { value: 'INVOICE_ACCEPTED',    label: 'Factura aceptada' },
  { value: 'INVOICE_REJECTED',    label: 'Factura rechazada' },
  { value: 'INVOICE_CONDITIONAL', label: 'Factura condicional' },
  { value: 'INVOICE_CONTINGENCY', label: 'En contingencia' },
  { value: 'INVOICE_QUEUED',      label: 'Factura encolada' },
  { value: 'INVOICE_SUBMITTED',   label: 'Enviada a DGII' },
  { value: 'INVOICE_ERROR',       label: 'Error en factura' },
  { value: 'INVOICE_VOIDED',      label: 'Factura anulada' },
  { value: 'INVOICE_CREATED',     label: 'Factura creada' },
  { value: 'CERTIFICATE_EXPIRING','label': 'Cert. por vencer' },
  { value: 'SEQUENCE_LOW',        label: 'Secuencia por agotarse' },
  { value: 'DOCUMENT_RECEIVED',   label: 'Documento recibido' },
] as const;

type WebhookEventValue = typeof WEBHOOK_EVENTS[number]['value'];

// ── Zod schemas ────────────────────────────────────────────────────────────────

const createSchema = z.object({
  url: z.string().url('Debe ser una URL válida (incluir https://)'),
});

const editSchema = z.object({
  url: z.string().url('URL inválida').optional().or(z.literal('')),
});

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchWebhooks(): Promise<WebhookSubscription[]> {
  const res = await apiClient.get<{ data: WebhookSubscription[] }>('/webhooks');
  return res.data.data;
}

async function fetchWebhookDetail(id: string): Promise<WebhookSubscription & { deliveries: WebhookDelivery[] }> {
  const res = await apiClient.get<{ data: WebhookSubscription & { deliveries: WebhookDelivery[] } }>(`/webhooks/${id}`);
  return res.data.data;
}

// ── EventPicker ────────────────────────────────────────────────────────────────

function EventPicker({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  function toggle(event: string) {
    onChange(selected.includes(event) ? selected.filter((e) => e !== event) : [...selected, event]);
  }
  return (
    <div className="flex flex-wrap gap-2 rounded-lg border p-3">
      {WEBHOOK_EVENTS.map(({ value, label }) => (
        <button key={value} type="button" onClick={() => toggle(value)} className="focus:outline-none">
          <Badge
            variant={selected.includes(value) ? 'default' : 'outline'}
            className="cursor-pointer hover:opacity-80 text-xs"
          >
            {label}
          </Badge>
        </button>
      ))}
    </div>
  );
}

// ── SecretRevealDialog ─────────────────────────────────────────────────────────

function SecretRevealDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && confirmed) onClose(); }}>
      <DialogContent
        className="max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="h-5 w-5" /> Webhook creado
          </DialogTitle>
          <DialogDescription>
            Este secret solo se muestra <strong>una vez</strong>. Guardalo para verificar las firmas HMAC en header{' '}
            <code>X-ECF-Signature</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-muted p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Secret HMAC</p>
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono break-all flex-1">{secret}</code>
            <button
              type="button"
              onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="rounded" />
          Confirmé que guardé el secret
        </label>
        <DialogFooter>
          <Button disabled={!confirmed} onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WebhookSubscription | null>(null);
  const [revealSecret, setRevealSecret] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createEvents, setCreateEvents] = useState<string[]>([]);
  const [editEvents, setEditEvents] = useState<string[]>([]);

  const { data: webhooks = [], isLoading } = useQuery({
    queryKey: ['my', 'webhooks'],
    queryFn: fetchWebhooks,
  });

  const { data: webhookDetail } = useQuery({
    queryKey: ['my', 'webhook-detail', expandedId],
    queryFn: () => fetchWebhookDetail(expandedId!),
    enabled: !!expandedId,
  });

  const {
    register: regCreate,
    handleSubmit: handleCreate,
    reset: resetCreate,
    formState: { errors: createErrors },
  } = useForm<{ url: string }>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createSchema) as any,
  });

  const {
    register: regEdit,
    handleSubmit: handleEdit,
    formState: { errors: editErrors },
  } = useForm<{ url?: string }>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(editSchema) as any,
  });

  const createMut = useMutation({
    mutationFn: async (data: { url: string }) => {
      const res = await apiClient.post<{ data: WebhookCreated }>('/webhooks', {
        url: data.url,
        events: createEvents as WebhookEventValue[],
      });
      return res.data.data;
    },
    onSuccess: (data) => {
      setCreateOpen(false);
      resetCreate();
      setCreateEvents([]);
      setRevealSecret(data.secret);
      void queryClient.invalidateQueries({ queryKey: ['my', 'webhooks'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Error al crear el webhook';
      toast.error(msg);
    },
  });

  const editMut = useMutation({
    mutationFn: async (data: { url?: string }) => {
      await apiClient.patch(`/webhooks/${editTarget!.id}`, {
        ...(data.url ? { url: data.url } : {}),
        ...(editEvents.length > 0 ? { events: editEvents } : {}),
      });
    },
    onSuccess: () => {
      toast.success('Webhook actualizado');
      setEditTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['my', 'webhooks'] });
    },
    onError: () => toast.error('Error al actualizar el webhook'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/webhooks/${id}`),
    onSuccess: () => {
      toast.success('Webhook eliminado');
      void queryClient.invalidateQueries({ queryKey: ['my', 'webhooks'] });
    },
    onError: () => toast.error('Error al eliminar el webhook'),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiClient.patch(`/webhooks/${id}`, { isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['my', 'webhooks'] }),
    onError: () => toast.error('Error al cambiar estado'),
  });

  function handleDelete(id: string) {
    if (!confirm('¿Eliminar este webhook y su historial? Esta acción no se puede deshacer.')) return;
    deleteMut.mutate(id);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Mis Webhooks</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Suscripciones para recibir notificaciones de eventos en tiempo real
          </p>
        </div>
        <Button className="gap-2" onClick={() => { setCreateEvents([]); setCreateOpen(true); }}>
          <Plus className="h-4 w-4" /> Nueva Suscripción
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Webhook className="h-5 w-5" /> Suscripciones
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y px-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="py-4"><Skeleton className="h-14" /></div>
              ))}
            </div>
          ) : webhooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Webhook className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No tenés suscripciones configuradas.</p>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Crear suscripción
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {webhooks.map((wh) => (
                <div key={wh.id}>
                  <div className="flex items-start justify-between px-4 py-3 gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-mono">{wh.url}</code>
                        <Badge variant={wh.isActive ? 'success' : 'secondary'}>
                          {wh.isActive ? 'Activo' : 'Inactivo'}
                        </Badge>
                        {wh.deliveryStats && (
                          <span className="text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3 w-3 inline mr-0.5 text-green-500" />{wh.deliveryStats.success}
                            <XCircle className="h-3 w-3 inline mx-1 text-destructive" />{wh.deliveryStats.failed}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {wh.events.slice(0, 5).map((e) => (
                          <Badge key={e} variant="outline" className="text-[10px]">
                            {WEBHOOK_EVENTS.find((ev) => ev.value === e)?.label ?? e}
                          </Badge>
                        ))}
                        {wh.events.length > 5 && (
                          <Badge variant="outline" className="text-[10px]">+{wh.events.length - 5}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setExpandedId(expandedId === wh.id ? null : wh.id)}
                      >
                        {expandedId === wh.id ? 'Ocultar' : 'Entregas'}
                      </Button>
                      <Switch
                        checked={wh.isActive}
                        onCheckedChange={(v) => toggleMut.mutate({ id: wh.id, isActive: v })}
                      />
                      <Button
                        size="sm" variant="ghost" className="h-7 w-7 p-0"
                        onClick={() => { setEditTarget(wh); setEditEvents([...wh.events]); }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(wh.id)}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {expandedId === wh.id && (
                    <div className="bg-muted/30 border-t px-4 py-3">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">Últimas entregas</p>
                      {!webhookDetail ? (
                        <Skeleton className="h-8" />
                      ) : !webhookDetail.deliveries?.length ? (
                        <p className="text-xs text-muted-foreground">Sin entregas todavía</p>
                      ) : (
                        <div className="space-y-1">
                          {webhookDetail.deliveries.slice(0, 10).map((d) => (
                            <div key={d.id} className="flex items-center gap-3 text-xs">
                              {d.statusCode && d.statusCode >= 200 && d.statusCode < 300
                                ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                                : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                              <span className="text-muted-foreground font-mono">{d.statusCode ?? '—'}</span>
                              <span className="font-medium">{d.event}</span>
                              <span className="text-muted-foreground ml-auto">{fmtDateTime(d.createdAt)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) resetCreate(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-5 w-5" /> Nueva Suscripción
            </DialogTitle>
            <DialogDescription>
              Cada entrega incluye header <code>X-ECF-Signature: sha256=...</code> para verificar la autenticidad.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={handleCreate((d) => {
              if (createEvents.length === 0) { toast.error('Seleccioná al menos un evento'); return; }
              createMut.mutate(d);
            })}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>URL *</Label>
              <Input placeholder="https://mi-sistema.com/webhooks/ecf" {...regCreate('url')} />
              {createErrors.url && <p className="text-xs text-destructive">{createErrors.url.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Eventos *</Label>
              <EventPicker selected={createEvents} onChange={setCreateEvents} />
              {createEvents.length === 0 && <p className="text-xs text-muted-foreground">Seleccioná al menos un evento</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Crear Suscripción
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(v) => { if (!v) setEditTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar Webhook</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit((d) => editMut.mutate(d))} className="space-y-4">
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input defaultValue={editTarget?.url} {...regEdit('url')} />
              {editErrors.url && <p className="text-xs text-destructive">{editErrors.url.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Eventos</Label>
              <EventPicker selected={editEvents} onChange={setEditEvents} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>Cancelar</Button>
              <Button type="submit" disabled={editMut.isPending}>
                {editMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Guardar cambios
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Secret reveal — copy once */}
      {revealSecret && (
        <SecretRevealDialog secret={revealSecret} onClose={() => setRevealSecret(null)} />
      )}
    </div>
  );
}
