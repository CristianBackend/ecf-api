import { ExcelRow } from './excel-mapper.interface';
import { mapBase } from './base-excel.mapper';

/** E45 — Comprobante Gubernamental Electrónico. Buyer RNC required. */
export function mapE45(row: ExcelRow, companyId: string): Record<string, unknown> {
  return mapBase(row, companyId, 'E45');
}
