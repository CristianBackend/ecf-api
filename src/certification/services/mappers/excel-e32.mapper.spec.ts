/**
 * E32 mapper — unit tests
 * Covers the most common certification case (Factura de Consumo).
 */
import { mapE32 } from './excel-e32.mapper';
import { ExcelRow } from './excel-mapper.interface';
import { encfToOverride } from './base-excel.mapper';

function makeE32Row(overrides: Partial<Record<string, unknown>> = {}): ExcelRow {
  return {
    CasoPrueba: '133158744E320000000011',
    TipoeCF: 32,
    eNCF: 'E320000000011',
    FechaEmision: '01-04-2020',
    RazonSocialComprador: 'Consumidor Final SRL',
    TipoPago: 1,
    _items: {
      1: {
        NombreItem: 'Laptop Dell',
        CantidadItem: 2,
        PrecioUnitarioItem: 35000,
        TasaITBIS: 18,
        IndicadorFacturacion: 1,
        IndicadorBienoServicio: 1,
      },
    },
    ...overrides,
  } as unknown as ExcelRow;
}

describe('mapE32', () => {
  it('sets ecfType to E32', () => {
    const dto = mapE32(makeE32Row(), 'company-uuid');
    expect(dto.ecfType).toBe('E32');
  });

  it('sets companyId from parameter', () => {
    const dto = mapE32(makeE32Row(), 'my-company-id');
    expect(dto.companyId).toBe('my-company-id');
  });

  it('extracts encfOverride from eNCF sequence number', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    // "E320000000011" → 11
    expect(dto.encfOverride).toBe(11);
  });

  it('encfToOverride utility is correct', () => {
    expect(encfToOverride('E320000000011')).toBe(11);
    expect(encfToOverride('E310000000001')).toBe(1);
    expect(encfToOverride('E470000099999')).toBe(99999);
    expect(encfToOverride(undefined)).toBeUndefined();
  });

  it('maps buyer name from RazonSocialComprador', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.buyer.name).toBe('Consumidor Final SRL');
  });

  it('omits buyer.rnc when RNCComprador is absent (valid for E32)', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.buyer.rnc).toBeUndefined();
  });

  it('maps buyer.rnc when RNCComprador is present', () => {
    const dto = mapE32(makeE32Row({ RNCComprador: '131234567' }), 'c') as any;
    expect(dto.buyer.rnc).toBe('131234567');
  });

  it('maps payment.type from TipoPago', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.payment.type).toBe(1);
  });

  it('maps items with correct fields', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].description).toBe('Laptop Dell');
    expect(dto.items[0].quantity).toBe(2);
    expect(dto.items[0].unitPrice).toBe(35000);
    expect(dto.items[0].itbisRate).toBe(18);
    expect(dto.items[0].indicadorFacturacion).toBe(1);
    expect(dto.items[0].goodService).toBe(1);
  });

  it('maps fechaEmision directly from Excel', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.fechaEmision).toBe('01-04-2020');
  });

  it('excludes #e sentinel values from buyer fields', () => {
    const dto = mapE32(makeE32Row({ DireccionComprador: '#e' }), 'c') as any;
    expect(dto.buyer.address).toBeUndefined();
  });

  it('sets idempotencyKey prefixed with cert-', () => {
    const dto = mapE32(makeE32Row(), 'c') as any;
    expect(dto.idempotencyKey).toMatch(/^cert-/);
  });

  it('handles multiple items sorted by line number', () => {
    const row = makeE32Row({
      _items: {
        2: { NombreItem: 'Item B', CantidadItem: 1, PrecioUnitarioItem: 100 },
        1: { NombreItem: 'Item A', CantidadItem: 2, PrecioUnitarioItem: 200 },
      },
    });
    const dto = mapE32(row, 'c') as any;
    expect(dto.items[0].description).toBe('Item A');
    expect(dto.items[1].description).toBe('Item B');
  });
});
