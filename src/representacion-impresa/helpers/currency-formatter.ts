function toNumber(value: any): number {
  if (value !== null && value !== undefined && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return Number(value);
}

/** "X,XXX.XX" con separador de miles — para mostrar en el PDF. */
export function formatCurrency(value: any): string {
  return toNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "XXXX.XX" sin separador de miles — para parámetros del QR. */
export function formatQrAmount(value: any): string {
  return toNumber(value).toFixed(2);
}
