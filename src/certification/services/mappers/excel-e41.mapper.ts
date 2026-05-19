import { ExcelRow } from './excel-mapper.interface';
import { mapBase, s, n } from './base-excel.mapper';

/**
 * E41 — Comprobante de Compras Electrónico.
 * The "buyer" in E41 is actually the vendor (proveedor) from whom we're buying.
 * Retention fields come from per-item data (already mapped in mapItem).
 */
export function mapE41(row: ExcelRow, companyId: string): Record<string, unknown> {
  const base = mapBase(row, companyId, 'E41');

  // Document-level retention totals (optional)
  const retention: Record<string, unknown> = {};
  if (n(row.ITBISRetenido)   !== undefined) retention.itbisRetenido   = n(row.ITBISRetenido);
  if (n(row.ISRRetencion)    !== undefined) retention.isrRetencion    = n(row.ISRRetencion);
  if (n(row.ITBISPercepcion) !== undefined) retention.itbisPercepcion = n(row.ITBISPercepcion);
  if (n(row.ISRPercepcion)   !== undefined) retention.isrPercepcion   = n(row.ISRPercepcion);

  return {
    ...base,
    ...(Object.keys(retention).length ? { retention } : {}),
  };
}
