/**
 * AcecfExcelParser — unit tests for Step 3 Excel parsing.
 */
import * as XLSX from 'xlsx';
import { AcecfExcelParser } from './acecf-excel-parser.service';
import { makeTestLogger } from '../../common/logger/test-logger';

function makeParser() {
  return new AcecfExcelParser(makeTestLogger() as any);
}

function buildAcecfXlsx(rows: Record<string, unknown>[], sheetName = 'ACEECF_Generadas'): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const VALID_ROW = {
  Version: '1.0',
  RNCEmisor: '131880681',
  eNCF: 'E310000000005',
  FechaEmision: '01-04-2020',
  MontoTotal: '83320.00',
  RNCComprador: '133158744',
  Estado: '1',
  DetalleMotivoRechazo: '',
  FechaHoraAprobacionComercial: '22-05-2026 22:09:37',
};

describe('AcecfExcelParser', () => {
  it('parses a valid ACEECF_Generadas sheet', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([VALID_ROW]);
    const rows = parser.parse(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].encf).toBe('E310000000005');
    expect(rows[0].ecfType).toBe('E31');
    expect(rows[0].emitterRnc).toBe('131880681');
    expect(rows[0].receiverRnc).toBe('133158744');
    expect(rows[0].totalAmount).toBe(83320.00);
    expect(rows[0].intendedEstado).toBe(1);
  });

  it('falls back to first sheet when ACEECF_Generadas is absent', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([VALID_ROW], 'Sheet1');
    const rows = parser.parse(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].encf).toBe('E310000000005');
  });

  it('returns issueDate as verbatim string dd-MM-yyyy (no Date object, no timezone)', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([VALID_ROW]);
    const rows = parser.parse(buf);
    // Must be a string, not a Date — timezone conversion causes off-by-one
    expect(typeof rows[0].issueDate).toBe('string');
    expect(rows[0].issueDate).toBe('01-04-2020');
  });

  it('issueDate string preserves dd-MM-yyyy exactly (regression: no UTC+offset shift)', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, FechaEmision: '02-12-2018' }]);
    const rows = parser.parse(buf);
    expect(rows[0].issueDate).toBe('02-12-2018');
  });

  it('handles Estado=2 with DetalleMotivoRechazo', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{
      ...VALID_ROW,
      Estado: '2',
      DetalleMotivoRechazo: 'Datos incorrectos del proveedor',
    }]);
    const rows = parser.parse(buf);
    expect(rows[0].intendedEstado).toBe(2);
    expect(rows[0].rejectionReason).toBe('Datos incorrectos del proveedor');
  });

  it('throws BadRequestException when Estado is neither 1 nor 2', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, Estado: '3' }]);
    expect(() => parser.parse(buf)).toThrow();
  });

  it('throws BadRequestException when Estado=2 but DetalleMotivoRechazo is empty', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, Estado: '2', DetalleMotivoRechazo: '' }]);
    expect(() => parser.parse(buf)).toThrow(/DetalleMotivoRechazo requerido/);
  });

  it('throws BadRequestException for invalid date format (ISO format rejected)', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, FechaEmision: '2020-04-01' }]);
    expect(() => parser.parse(buf)).toThrow(/FechaEmision inválido/);
  });

  it('reads FechaHoraAprobacionComercial verbatim', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, FechaHoraAprobacionComercial: '22-05-2026 22:09:37' }]);
    const rows = parser.parse(buf);
    expect(rows[0].approvalDatetime).toBe('22-05-2026 22:09:37');
  });

  it('throws when FechaHoraAprobacionComercial is missing', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, FechaHoraAprobacionComercial: '' }]);
    expect(() => parser.parse(buf)).toThrow(/FechaHoraAprobacionComercial es requerido/);
  });

  it('throws when FechaHoraAprobacionComercial has wrong format', () => {
    const parser = makeParser();
    const buf = buildAcecfXlsx([{ ...VALID_ROW, FechaHoraAprobacionComercial: '2026-05-22 22:09:37' }]);
    expect(() => parser.parse(buf)).toThrow(/FechaHoraAprobacionComercial inválido/);
  });

  it('parses 11 rows matching the real DGII Paso 3 dataset', () => {
    const parser = makeParser();
    const dataRows = [
      { ...VALID_ROW, eNCF: 'E310000000005', MontoTotal: '83320.00' },
      { ...VALID_ROW, eNCF: 'E310000000006', MontoTotal: '228460.50' },
      { ...VALID_ROW, eNCF: 'E310000000008', MontoTotal: '1505.00' },
      { ...VALID_ROW, eNCF: 'E310000000034', MontoTotal: '25000000.00' },
      { ...VALID_ROW, eNCF: 'E330000000001', FechaEmision: '02-04-2020', MontoTotal: '400000.00' },
      { ...VALID_ROW, eNCF: 'E340000000015', FechaEmision: '02-04-2020', MontoTotal: '0.00' },
      { ...VALID_ROW, eNCF: 'E340000000018', FechaEmision: '02-12-2018', MontoTotal: '0.00' },
      { ...VALID_ROW, eNCF: 'E440000000007', MontoTotal: '432000.00' },
      { ...VALID_ROW, eNCF: 'E440000000009', MontoTotal: '432000.00' },
      { ...VALID_ROW, eNCF: 'E450000000009', MontoTotal: '560925.00' },
      { ...VALID_ROW, eNCF: 'E450000000010', MontoTotal: '936920.00' },
    ];
    const buf = buildAcecfXlsx(dataRows);
    const rows = parser.parse(buf);
    expect(rows).toHaveLength(11);
    expect(rows.map(r => r.ecfType)).toEqual([
      'E31', 'E31', 'E31', 'E31', 'E33', 'E34', 'E34', 'E44', 'E44', 'E45', 'E45',
    ]);
  });
});
