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

  it('groups TelefonoEmisor[N] as an array on the row, not under _items', () => {
    const buf = buildXlsx([
      {
        TipoeCF: 31,
        eNCF: 'E310000000001',
        'TelefonoEmisor[1]': '8095551111',
        'TelefonoEmisor[2]': '8095552222',
        'NombreItem[1]': 'Producto A',
      },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows[0].TelefonoEmisor).toEqual(['8095551111', '8095552222']);
    // _items must NOT have a phantom TelefonoEmisor inside it
    expect((rows[0]._items[1] as any).TelefonoEmisor).toBeUndefined();
    expect((rows[0]._items[1] as any).NombreItem).toBe('Producto A');
  });

  it('groups FormaPago[N] and MontoPago[N] on the row, not under _items', () => {
    const buf = buildXlsx([
      {
        TipoeCF: 31,
        eNCF: 'E310000000001',
        'FormaPago[1]': 1,
        'MontoPago[1]': 1000,
        'FormaPago[2]': 4,
        'MontoPago[2]': 500,
      },
    ]);

    const rows = parser.parseBuffer(buf);
    expect(rows[0].FormaPago).toEqual([1, 4]);
    expect(rows[0].MontoPago).toEqual([1000, 500]);
    // No item entries should be created from these
    expect(Object.keys(rows[0]._items)).toHaveLength(0);
  });

  // Fix 4m: TablaSubDescuento and TablaSubRecargo Excel headers use a double
  // index `Field[N][M]`. The parser must group those entries into per-item
  // sub-arrays so downstream mappers can emit the XSD-required tables.
  describe('Fix 4m — sub-indexed sub-discount/sub-recharge headers', () => {
    it('groups TipoSubDescuento[1][1..2] into _items[1].subDescuentos', () => {
      const buf = buildXlsx([
        {
          TipoeCF: 46,
          eNCF: 'E460000000010',
          'NombreItem[1]': 'Item A',
          'DescuentoMonto[1]': 500.00,
          'TipoSubDescuento[1][1]': '$',
          'MontoSubDescuento[1][1]': 500.00,
          'TipoSubDescuento[1][2]': '%',
          'SubDescuentoPorcentaje[1][2]': 10,
          'MontoSubDescuento[1][2]': 50.00,
        },
      ]);

      const rows = parser.parseBuffer(buf);
      const item1 = rows[0]._items[1] as any;
      expect(Array.isArray(item1.subDescuentos)).toBe(true);
      expect(item1.subDescuentos).toHaveLength(2);
      expect(item1.subDescuentos[0]).toEqual({
        TipoSubDescuento: '$',
        MontoSubDescuento: 500,
      });
      expect(item1.subDescuentos[1]).toEqual({
        TipoSubDescuento: '%',
        SubDescuentoPorcentaje: 10,
        MontoSubDescuento: 50,
      });
    });

    it('normalizes the Excel typo `MontosubRecargo` to XSD-correct `MontoSubRecargo`', () => {
      // The official DGII certification Excel ships with the lowercase-s
      // typo. The parser's SUB_ITEM_TARGETS table accepts both spellings
      // and stores under the XSD-correct key.
      const buf = buildXlsx([
        {
          TipoeCF: 41,
          eNCF: 'E410000000007',
          'NombreItem[1]': 'Item A',
          'RecargoMonto[1]': 57.75,
          'TipoSubRecargo[1][1]': '%',
          'SubRecargoPorcentaje[1][1]': 1.00,
          'MontosubRecargo[1][1]': 57.75,   // <-- typo
        },
      ]);

      const rows = parser.parseBuffer(buf);
      const item1 = rows[0]._items[1] as any;
      expect(Array.isArray(item1.subRecargos)).toBe(true);
      expect(item1.subRecargos).toHaveLength(1);
      // The XSD-correct key, not the Excel typo:
      expect(item1.subRecargos[0]).toEqual({
        TipoSubRecargo: '%',
        SubRecargoPorcentaje: 1,
        MontoSubRecargo: 57.75,
      });
    });

    it('keeps sub-arrays separate per item line', () => {
      const buf = buildXlsx([
        {
          TipoeCF: 41,
          eNCF: 'E410000000007',
          'NombreItem[1]': 'Item A',
          'TipoSubRecargo[1][1]': '%',
          'MontoSubRecargo[1][1]': 10,
          'NombreItem[2]': 'Item B',
          'TipoSubRecargo[2][1]': '$',
          'MontoSubRecargo[2][1]': 20,
        },
      ]);

      const rows = parser.parseBuffer(buf);
      expect((rows[0]._items[1] as any).subRecargos).toHaveLength(1);
      expect((rows[0]._items[2] as any).subRecargos).toHaveLength(1);
      expect((rows[0]._items[1] as any).subRecargos[0].TipoSubRecargo).toBe('%');
      expect((rows[0]._items[2] as any).subRecargos[0].TipoSubRecargo).toBe('$');
    });
  });
});
