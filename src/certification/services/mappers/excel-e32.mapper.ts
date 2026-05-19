import { ExcelRow } from './excel-mapper.interface';
import { mapBase } from './base-excel.mapper';

/** E32 — Factura de Consumo Electrónica. Buyer RNC optional. */
export function mapE32(row: ExcelRow, companyId: string): Record<string, unknown> {
  return mapBase(row, companyId, 'E32');
}
