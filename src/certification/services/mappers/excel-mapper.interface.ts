/**
 * Interfaces for the Excel → CreateInvoiceDto mapper pipeline.
 *
 * ExcelRow: a flat parsed row from the DGII certification Excel.
 *   - All regular column values keyed by header name.
 *   - `_items`: item fields grouped by line number (1-based).
 *   Values that were '#e' or empty in the source are already absent.
 *
 * ExcelMapper: one mapper per e-CF type; converts an ExcelRow into
 *   a DTO-compatible object that InvoicesService.create() accepts.
 */

/**
 * Fix 4m: A single entry inside an item's TablaSubDescuento or TablaSubRecargo.
 * Per DGII XSD each item can have 1..12 of these. All three fields are typed
 * as optional because XSD declares Porcentaje and Monto as optional and the
 * Excel may carry partial entries.
 */
export interface ExcelSubAdjustment {
  TipoSubDescuento?: string | number;
  SubDescuentoPorcentaje?: string | number;
  MontoSubDescuento?: string | number;
  TipoSubRecargo?: string | number;
  SubRecargoPorcentaje?: string | number;
  MontoSubRecargo?: string | number;
}

export interface ExcelItem {
  [field: string]:
    | string
    | number
    | undefined
    | ExcelSubAdjustment[]; // subDescuentos / subRecargos populated by Fix 4m
}

export interface ExcelRow {
  [field: string]: string | number | undefined | Record<number, ExcelItem>;
  /** Items grouped by 1-based line number, e.g. `_items[1].NombreItem` */
  _items: Record<number, ExcelItem>;
}

export interface ExcelMapper {
  readonly ecfType: string;
  /** Map a parsed Excel row to a CreateInvoiceDto-compatible plain object. */
  map(row: ExcelRow, companyId: string): Record<string, unknown>;
}
