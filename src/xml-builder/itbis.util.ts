import { InvoiceItemInput } from './invoice-input.interface';

/**
 * SINGLE SOURCE OF TRUTH for per-line ITBIS classification.
 *
 * Both the e-CF XML builder (XmlBuilderService.calculateTotals) and the
 * persisted InvoiceLine MUST use these helpers so the ITBIS stored in the DB can
 * NEVER diverge from the ITBIS declared to DGII in the e-CF. The previous bug:
 * the DB persisted `lineSubtotal * (rate/100)` with a default rate of 18,
 * ignoring IndicadorFacturacion — so an Exento item carried ITBIS in the DB
 * (and in 606/607 reports) even though the emitted e-CF correctly carried none.
 */

/** Rounding to 2 decimals — same formula as ValidationService.round2. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve the DGII IndicadorFacturacion for a line:
 *   0 = No Facturable, 1 = ITBIS 18%, 2 = ITBIS 16%, 3 = ITBIS 0%, 4 = Exento.
 * Uses the explicit item value when present; otherwise derives it from the
 * ITBIS rate (18→1, 16→2, 0→3, default→1).
 */
export function resolveIndicadorFacturacion(
  item: Pick<InvoiceItemInput, 'indicadorFacturacion'>,
  rate: number,
): number {
  if (item.indicadorFacturacion !== undefined && item.indicadorFacturacion !== null) {
    return item.indicadorFacturacion;
  }
  if (rate === 18) return 1;
  if (rate === 16) return 2;
  if (rate === 0) return 3;
  return 1; // default ITBIS 18%
}

/**
 * Effective ITBIS rate (%) a line actually carries given its indicador.
 * No Facturable (0), ITBIS 0% (3) and Exento (4) carry 0%.
 */
export function effectiveItbisRate(indicadorFact: number, rate: number): number {
  switch (indicadorFact) {
    case 1:
      return 18;
    case 2:
      return 16;
    case 3: // ITBIS 0%
    case 4: // Exento
    case 0: // No Facturable
      return 0;
    default:
      // Unreachable for a resolved indicador (always 0..4); mirror the builder's
      // rate-based fallback just in case.
      return rate === 16 ? 16 : rate === 0 ? 0 : 18;
  }
}

/**
 * ITBIS amount a line carries (rounded to 2 dp). The single computation shared
 * by the XML builder and the persisted InvoiceLine.
 */
export function lineItbisAmount(
  lineSubtotal: number,
  indicadorFact: number,
  rate: number,
): number {
  return round2(lineSubtotal * (effectiveItbisRate(indicadorFact, rate) / 100));
}
