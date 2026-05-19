import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as XLSX from 'xlsx';
import { ExcelRow, ExcelItem } from './mappers/excel-mapper.interface';

const ITEM_FIELD_RE = /^(.+)\[(\d+)\]$/;
const EXCLUDED_VALUE = '#e';
const ECF_SHEET_NAME = 'ECF';

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

      const itemMatch = ITEM_FIELD_RE.exec(header);
      if (itemMatch) {
        const fieldName = itemMatch[1];
        const lineNum = parseInt(itemMatch[2], 10);
        if (!row._items[lineNum]) row._items[lineNum] = {};
        (row._items[lineNum] as Record<string, unknown>)[fieldName] = raw;
      } else {
        row[header] = raw;
      }
    }

    return row as ExcelRow;
  }
}
