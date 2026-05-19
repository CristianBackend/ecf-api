import { ExcelRow } from './excel-mapper.interface';
import { mapBase, s, int } from './base-excel.mapper';

/**
 * E47 — Comprobante de Pagos al Exterior.
 * Requires ForeignBeneficiary (beneficiario en el exterior).
 */
export function mapE47(row: ExcelRow, companyId: string): Record<string, unknown> {
  const base = mapBase(row, companyId, 'E47');

  const foreignBeneficiary: Record<string, unknown> = {
    name:        s(row.NombreBeneficiario) ?? s(row.RazonSocialComprador) ?? 'Foreign Beneficiary',
    taxId:       s(row.IdentificacionBeneficiario) ?? s(row.IdentificadorExtranjero),
    address:     s(row.DireccionBeneficiario) ?? s(row.DireccionComprador),
    country:     s(row.NombrePaisBeneficiario) ?? s(row.PaisCompradorResidencia) ?? 'US',
    incomeType:  int(row.TipoRenta),
    concept:     s(row.ConceptoPago),
  };
  Object.keys(foreignBeneficiary).forEach(
    k => foreignBeneficiary[k] === undefined && delete foreignBeneficiary[k],
  );

  return {
    ...base,
    foreignBeneficiary,
  };
}
