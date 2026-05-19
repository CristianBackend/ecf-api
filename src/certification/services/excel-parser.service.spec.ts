/**
 * ExcelParserService — unit tests
 *
 * These tests use real XLSX-generated buffers to verify that the parser
 * correctly extracts ExcelRow objects from a certification spreadsheet.
 */
import * as XLSX from 'xlsx';
import { ExcelParserService } from './excel-parser.service';
import { makeTestLogger } from '../../common/logger/test-logger';

function buildXlsx(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ECF');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('ExcelParserService', () => {
  let parser: ExcelParserService;

  beforeEach(() => {
    parser = new ExcelParserService(makeTestLogger() as any);
  });

  it('parses a single row with scalar fields', () => {
    const buf = buildXlsx([
      {
        CasoPrueba: '133158744E320000000011',
        TipoeCF: 32,
        eNCF: 'E320000000011',
        FechaEmision: '01-04-2020',
        RNCComprador: '101234567',
        RazonSocialComprador: 'Consumidor Test',
        TipoPago: 1,
      },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].TipoeCF).toBe(32);
    expect(rows[0].eNCF).toBe('E320000000011');
    expect(rows[0].RNCComprador).toBe('101234567');
  });

  it('groups item fields under _items by line number', () => {
    const buf = buildXlsx([
      {
        TipoeCF: 31,
        eNCF: 'E310000000001',
        'NombreItem[1]': 'Producto A',
        'CantidadItem[1]': 2,
        'PrecioUnitarioItem[1]': 500,
        'TasaITBIS[1]': 18,
        'NombreItem[2]': 'Producto B',
        'CantidadItem[2]': 1,
        'PrecioUnitarioItem[2]': 300,
        TipoPago: 1,
      },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows[0]._items[1]).toMatchObject({
      NombreItem: 'Producto A',
      CantidadItem: 2,
      PrecioUnitarioItem: 500,
      TasaITBIS: 18,
    });
    expect(rows[0]._items[2]).toMatchObject({
      NombreItem: 'Producto B',
      CantidadItem: 1,
    });
  });

  it('excludes cells with "#e" sentinel value', () => {
    const buf = buildXlsx([
      {
        TipoeCF: 32,
        eNCF: 'E320000000011',
        RNCComprador: '#e',
        RazonSocialComprador: 'Consumidor',
        TipoPago: 1,
      },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows[0].RNCComprador).toBeUndefined();
    expect(rows[0].RazonSocialComprador).toBe('Consumidor');
  });

  it('skips completely empty rows', () => {
    // XLSX with 3 rows where the middle one is all empty
    const ws = XLSX.utils.aoa_to_sheet([
      ['TipoeCF', 'eNCF', 'TipoPago'],
      [32, 'E320000000011', 1],
      [undefined, undefined, undefined],
      [31, 'E310000000001', 1],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ECF');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const rows = parser.parseBuffer(buf);
    expect(rows).toHaveLength(2);
  });

  it('falls back to first sheet when "ECF" sheet is absent', () => {
    const ws = XLSX.utils.json_to_sheet([{ TipoeCF: 43, eNCF: 'E430000000001', TipoPago: 1 }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const rows = parser.parseBuffer(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].TipoeCF).toBe(43);
  });

  it('throws BadRequestException on invalid file buffer', () => {
    expect(() => parser.parseBuffer(Buffer.from('not an xlsx file'))).toThrow();
  });

  it('returns multiple rows preserving order', () => {
    const buf = buildXlsx([
      { TipoeCF: 31, eNCF: 'E310000000001', TipoPago: 1 },
      { TipoeCF: 32, eNCF: 'E320000000001', TipoPago: 1 },
      { TipoeCF: 33, eNCF: 'E330000000001', TipoPago: 1 },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows).toHaveLength(3);
    expect(rows[0].TipoeCF).toBe(31);
    expect(rows[1].TipoeCF).toBe(32);
    expect(rows[2].TipoeCF).toBe(33);
  });
});
