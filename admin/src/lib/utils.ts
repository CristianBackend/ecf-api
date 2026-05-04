import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtDate(date: string | Date | null | undefined): string {
  if (!date) return '—';
  return format(new Date(date), 'dd/MM/yyyy', { locale: es });
}

export function fmtDateTime(date: string | Date | null | undefined): string {
  if (!date) return '—';
  return format(new Date(date), 'dd/MM/yyyy HH:mm', { locale: es });
}

export function fmtRelative(date: string | Date | null | undefined): string {
  if (!date) return '—';
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: es });
}

export function fmtMoney(amount: number | string | null | undefined, currency = 'DOP'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('es-DO', { style: 'currency', currency }).format(Number(amount));
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return '0';
  return new Intl.NumberFormat('es-DO').format(n);
}

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
