'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Key, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/utils';
import type { ApiKey } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateApiKeyDialog } from '@/components/tenants/create-api-key-dialog';

async function fetchKeys(): Promise<ApiKey[]> {
  const res = await apiClient.get<{ data: ApiKey[] }>('/auth/keys');
  return res.data.data;
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ['my', 'api-keys'],
    queryFn: fetchKeys,
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/auth/keys/${id}`);
    },
    onSuccess: () => {
      toast.success('API key revocada');
      void queryClient.invalidateQueries({ queryKey: ['my', 'api-keys'] });
    },
    onError: () => toast.error('Error al revocar la key'),
  });

  function handleRevoke(id: string) {
    if (!confirm('¿Revocar esta API key? Esta acción no se puede deshacer.')) return;
    revokeMutation.mutate(id);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Mis API Keys</h1>
          <p className="text-sm text-muted-foreground mt-1">Claves de acceso programático a la API</p>
        </div>
        <Button className="gap-2" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> Nueva API Key
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="h-5 w-5" /> API Keys activas
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y px-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="py-3"><Skeleton className="h-10" /></div>
              ))}
            </div>
          ) : keys.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No tenés API keys. Creá una para empezar a integrar.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {['Nombre', 'Prefijo', 'Tipo', 'Estado', 'Último uso', ''].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b">
                    <td className="px-4 py-2 font-medium">{k.name}</td>
                    <td className="px-4 py-2 font-mono text-xs">{k.keyPrefix}…</td>
                    <td className="px-4 py-2">
                      <Badge variant={k.isLive ? 'default' : 'secondary'}>
                        {k.isLive ? 'Live' : 'Test'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={k.isActive ? 'success' : 'destructive'}>
                        {k.isActive ? 'Activa' : 'Revocada'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {k.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => handleRevoke(k.id)}
                          disabled={revokeMutation.isPending}
                        >
                          <Trash2 className="h-3 w-3 mr-1" /> Revocar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        allowAdminScope={false}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['my', 'api-keys'] })}
      />
    </div>
  );
}
