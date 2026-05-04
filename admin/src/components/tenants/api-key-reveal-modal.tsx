'use client';

import { useState } from 'react';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface ApiKeyRevealModalProps {
  open: boolean;
  keys: { test?: string; live?: string } | null;
  onConfirm: () => void;
}

function CopyableKey({ label, value, isLive }: { label: string; value: string; isLive: boolean }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-yellow-500/30 bg-yellow-50/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <Badge variant={isLive ? 'default' : 'secondary'}>{isLive ? 'Live' : 'Test'}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono bg-muted rounded px-2 py-1.5 break-all">{value}</code>
        <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={handleCopy}>
          {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {copied && <p className="text-xs text-green-600 font-medium">¡Copiado al portapapeles!</p>}
    </div>
  );
}

export function ApiKeyRevealModal({ open, keys, onConfirm }: ApiKeyRevealModalProps) {
  if (!keys) return null;

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      {/* hideClose + onOpenChange noop = no se cierra con click fuera ni Escape */}
      <DialogContent hideClose className="max-w-lg" onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/40">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <DialogTitle>¡Guardá estas claves ahora!</DialogTitle>
          </div>
          <DialogDescription>
            <strong className="text-foreground">Estas API keys NO se mostrarán de nuevo.</strong> Copiálas en un lugar seguro (gestor de contraseñas, vault, etc.) antes de continuar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 my-2">
          {keys.test && <CopyableKey label="Test API Key" value={keys.test} isLive={false} />}
          {keys.live && <CopyableKey label="Live API Key" value={keys.live} isLive />}
        </div>

        <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-300">
          Una vez cerrado este modal, solo verás los últimos caracteres de cada clave. No hay forma de recuperarlas — tendrás que generar unas nuevas si las perdés.
        </div>

        <Button className="w-full mt-2" onClick={onConfirm}>
          Confirmo que guardé las claves — Cerrar
        </Button>
      </DialogContent>
    </Dialog>
  );
}
