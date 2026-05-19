import { ExcelRow } from './excel-mapper.interface';
import { mapBase, mapReference } from './base-excel.mapper';

/** E34 — Nota de Crédito Electrónica. Requires InformacionReferencia. */
export function mapE34(row: ExcelRow, companyId: string): Record<string, unknown> {
  return {
    ...mapBase(row, companyId, 'E34'),
    reference: mapReference(row),
  };
}
