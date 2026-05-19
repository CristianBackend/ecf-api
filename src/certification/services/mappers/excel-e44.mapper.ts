import { ExcelRow } from './excel-mapper.interface';
import { mapBase } from './base-excel.mapper';

/** E44 — Comprobante de Regímenes Especiales. */
export function mapE44(row: ExcelRow, companyId: string): Record<string, unknown> {
  return mapBase(row, companyId, 'E44');
}
