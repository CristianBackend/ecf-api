import { ExcelRow } from './excel-mapper.interface';
import { mapBase, mapReference } from './base-excel.mapper';

/** E33 — Nota de Débito Electrónica. Requires InformacionReferencia. */
export function mapE33(row: ExcelRow, companyId: string): Record<string, unknown> {
  return {
    ...mapBase(row, companyId, 'E33'),
    reference: mapReference(row),
  };
}
