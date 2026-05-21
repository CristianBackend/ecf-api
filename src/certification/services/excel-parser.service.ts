import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as XLSX from 'xlsx';
import { ExcelRow, ExcelItem } from './mappers/excel-mapper.interface';

// Fix 4m: support both single-index item fields (`Name[N]`) and double-index
// sub-item fields (`Name[N][M]`). The double-index pattern is used by the
// DGII test set for TablaSubDescuento and TablaSubRecargo:
//   TipoSubDescuento[1][1], SubDescuentoPorcentaje[1][1], MontoSubDescuento[1][1]
//   TipoSubDescuento[1][2], ... etc.
// where the first index is the item line number and the second is the
// sub-discount/recharge entry within that item (1..12 per XSD).
const ITEM_FIELD_RE = /^(.+)\[(\d+)\]$/;
const SUB_ITEM_FIELD_RE = /^(.+)\[(\d+)\]\[(\d+)\]$/;
const EXCLUDED_VALUE = '#e';
const ECF_SHEET_NAME = 'ECF';

/**
 * Fields with [N] indexers that are NOT line items but rather sized arrays of
 * the same header-level property. These get stored on the row as base-name
 * arrays (e.g. row.TelefonoEmisor = ['8095551234', '8095555678']) instead of
 * being mistakenly grouped into row._items[N].TelefonoEmisor.
 *
 * Detected from the official DGII certification Excel by their max index ≤ 7,
 * vs. true item fields which max at 62.
 */
const NON_ITEM_INDEXED_FIELDS = new Set<string>([
  'TelefonoEmisor',
  'FormaPago',
  'MontoPago',
]);

/**
 * Fix 4m: map double-indexed `field[N][M]` headers to the per-item sub-array
 * name where they are accumulated.
 *
 * The Excel headers in the DGII certification set use SubDescuento/SubRecargo
 * fields with a double index, where [N] is the parent item line and [M] is the
 * 1-based entry within the table for that item. We collect them into
 * `_items[N].subDescuentos[M-1]` / `_items[N].subRecargos[M-1]` so the mapper
 * can emit a proper array.
 *
 * The Excel uses `MontosubRecargo` (lowercase 's') instead of the XSD's
 * `MontoSubRecargo` for the amount field — we read what the Excel actually
 * has and normalize the key when storing.
 */
const SUB_ITEM_TARGETS: Record<string, { arrayName: string; key: string }> = {
  TipoSubDescuento:        { arrayName: 'subDescuentos', key: 'TipoSubDescuento' },
  SubDescuentoPorcentaje:  { arrayName: 'subDescuentos', key: 'SubDescuentoPorcentaje' },
  MontoSubDescuento:       { arrayName: 'subDescuentos', key: 'MontoSubDescuento' },
  TipoSubRecargo:          { arrayName: 'subRecargos',   key: 'TipoSubRecargo' },
  SubRecargoPorcentaje:    { arrayName: 'subRecargos',   key: 'SubRecargoPorcentaje' },
  MontoSubRecargo:         { arrayName: 'subRecargos',   key: 'MontoSubRecargo' },
  // The Excel header is misspelled (`MontosubRecargo` with lowercase s in
  // 'sub'); accept it and normalize to the XSD-correct `MontoSubRecargo`.
  MontosubRecargo:         { arrayName: 'subRecargos',   key: 'MontoSubRecargo' },
};

@Injectable()
export class ExcelParserService {
  constructor(
    @InjectPinoLogger(ExcelParserService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Parse a DGII certification Excel file buffer.
   * Returns one ExcelRow per data row (row 2 onwards).
   * Row 1 must contain the field headers.
   */
  parseBuffer(fileBuffer: Buffer): ExcelRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    } catch {
      throw new BadRequestException('No se pudo leer el archivo. ¿Es un .xlsx válido?');
    }

    // Try the canonical sheet name first, then fall back to the first sheet
    const sheetName = workbook.SheetNames.includes(ECF_SHEET_NAME)
      ? ECF_SHEET_NAME
      : workbook.SheetNames[0];

    if (!sheetName) {
      throw new BadRequestException('El archivo Excel no contiene hojas');
    }

    const sheet = workbook.Sheets[sheetName];

    // sheet_to_json with header:1 returns arrays; raw:true preserves numbers
    const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: undefined,
      raw: true,
    });

    if (rawRows.length < 2) {
      throw new BadRequestException(
        `La hoja "${sheetName}" debe tener al menos una fila de encabezados y una de datos`,
      );
    }

    const headers = (rawRows[0] as (string | undefined)[]).map(h =>
      h !== undefined && h !== null ? String(h).trim() : '',
    );

    const dataRows = rawRows.slice(1);
    const rows: ExcelRow[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rawRow = dataRows[i] as (string | number | undefined)[];

      // Skip completely empty rows
      if (!rawRow || rawRow.every(cell => cell === undefined || cell === null || cell === '')) {
        continue;
      }

      rows.push(this.buildRow(headers, rawRow, i + 2));
    }

    this.logger.debug(`Excel parsed: ${rows.length} data rows from sheet "${sheetName}"`);
    return rows;
  }

  private buildRow(
    headers: string[],
    cells: (string | number | undefined)[],
    _rowIndex: number,
  ): ExcelRow {
    const row: Record<string, unknown> & { _items: Record<number, ExcelItem> } = {
      _items: {},
    };

    for (let col = 0; col < headers.length; col++) {
      const header = headers[col];
      if (!header) continue;

      const raw = cells[col];
      // Treat '#e', empty, and missing as "not included"
      if (raw === undefined || raw === null || raw === '' || raw === EXCLUDED_VALUE) continue;

      // Fix 4m: check for double-index `field[N][M]` BEFORE the single-index
      // regex (which would otherwise greedily match "field[N]" as the prefix
      // and "[M]" as the index for some headers). When matched, the value
      // goes into a per-item sub-array (subDescuentos / subRecargos).
      const subItemMatch = SUB_ITEM_FIELD_RE.exec(header);
      if (subItemMatch) {
        const fieldName = subItemMatch[1];
        const lineNum = parseInt(subItemMatch[2], 10);
        const subIdx = parseInt(subItemMatch[3], 10);

        const target = SUB_ITEM_TARGETS[fieldName];
        if (!target) {
          // Unknown double-index header — fall through to base-string path
          // to preserve old behavior for any unexpected fields.
          row[header] = raw;
          continue;
        }

        if (!row._items[lineNum]) row._items[lineNum] = {};
        const item = row._items[lineNum] as Record<string, unknown>;
        let arr = item[target.arrayName] as Array<Record<string, unknown>> | undefined;
        if (!arr) {
          arr = [];
          item[target.arrayName] = arr;
        }
        const entryIdx = subIdx - 1; // Excel is 1-based, our array is 0-based
        if (!arr[entryIdx]) arr[entryIdx] = {};
        arr[entryIdx][target.key] = raw;
        continue;
      }

      const itemMatch = ITEM_FIELD_RE.exec(header);
      if (itemMatch) {
        const fieldName = itemMatch[1];
        const lineNum = parseInt(itemMatch[2], 10);

        // Non-item indexed fields (e.g. TelefonoEmisor[1..3], FormaPago[1..7])
        // go on the row as arrays, not into _items.
        if (NON_ITEM_INDEXED_FIELDS.has(fieldName)) {
          const existing = (row[fieldName] as unknown[] | undefined) ?? [];
          existing[lineNum - 1] = raw;
          row[fieldName] = existing;
          continue;
        }

        if (!row._items[lineNum]) row._items[lineNum] = {};
        (row._items[lineNum] as Record<string, unknown>)[fieldName] = raw;
      } else {
        row[header] = raw;
      }
    }

    return row as ExcelRow;
  }
}
