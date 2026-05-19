import { ExcelRow } from './excel-mapper.interface';
import { mapBase } from './base-excel.mapper';

/** E43 — Comprobante de Gastos Menores. No buyer RNC required. */
export function mapE43(row: ExcelRow, companyId: string): Record<string, unknown> {
  return mapBase(row, companyId, 'E43');
}
