'use client';

import { useState, useRef } from 'react';
import { Loader2, Eye, EyeOff, Upload, FileKey } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Company } from '@/types/api';

interface CertificateUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: Company[];
  tenantId: string;
  /** If provided, called instead of the default admin query invalidation. */
  onSuccess?: () => void;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadCertificate(companyId: string, p12Base64: string, passphrase: string) {
  const res = await apiClient.post(`/companies/${companyId}/certificates`, {
    companyId,
    p12Base64,
    passphrase,
  });
  return res.data;
}

export function CertificateUploadDialog({ open, onOpenChange, companies, tenantId, onSuccess }: CertificateUploadDialogProps) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [fileError, setFileError] = useState('');
  const [passError, setPassError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('Seleccioná un archivo .p12');
      const b64 = await fileToBase64(selectedFile);
      return uploadCertificate(companyId, b64, passphrase);
    },
    onSuccess: () => {
      toast.success('Certificado subido y activado exitosamente');
      onOpenChange(false);
      setSelectedFile(null);
      setPassphrase('');
      if (onSuccess) {
        onSuccess();
      } else {
        void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants', tenantId] });
      }
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Error al subir el certificado';
      toast.error(msg);
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileError('');
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'p12' && ext !== 'pfx') {
      setFileError('Solo se aceptan archivos .p12 o .pfx');
      return;
    }
    setSelectedFile(file);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let valid = true;
    if (!selectedFile) { setFileError('Seleccioná un archivo .p12'); valid = false; }
    if (!passphrase.trim()) { setPassError('La contraseña del certificado es requerida'); valid = false; }
    if (!valid) return;
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileKey className="h-5 w-5" /> Subir Certificado .p12
          </DialogTitle>
          <DialogDescription>
            El certificado se cifra con AES-GCM antes de almacenarse. Solo puede haber uno activo por empresa.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Company selector */}
          {companies.length > 1 && (
            <div className="space-y-1.5">
              <Label>Empresa</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccioná empresa..." />
                </SelectTrigger>
                <SelectContent position="popper">
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.businessName} ({c.rnc})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* File picker */}
          <div className="space-y-1.5">
            <Label>Archivo .p12 / .pfx *</Label>
            <div
              className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border p-6 cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-8 w-8 text-muted-foreground mb-2" />
              {selectedFile ? (
                <p className="text-sm font-medium">{selectedFile.name}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Click para seleccionar archivo</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">Solo .p12 y .pfx</p>
            </div>
            <input ref={fileRef} type="file" accept=".p12,.pfx" className="hidden" onChange={handleFileChange} />
            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>

          {/* Passphrase */}
          <div className="space-y-1.5">
            <Label>Contraseña del certificado *</Label>
            <div className="relative">
              <Input
                type={showPass ? 'text' : 'password'}
                placeholder="Contraseña del .p12"
                value={passphrase}
                onChange={(e) => { setPassphrase(e.target.value); setPassError(''); }}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPass(!showPass)}
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {passError && <p className="text-xs text-destructive">{passError}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Subiendo...</> : 'Subir Certificado'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
