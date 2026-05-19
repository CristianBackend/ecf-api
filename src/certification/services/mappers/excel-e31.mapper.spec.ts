/**
 * E31 mapper — unit tests (Factura de Crédito Fiscal)
 */
import { mapE31 } from './excel-e31.mapper';
import { ExcelRow } from './excel-mapper.interface';

function makeE31Row(overrides: Partial<Record<string, unknown>> = {}): ExcelRow {
  return {
    TipoeCF: 31,
    eNCF: 'E310000000001',
    FechaEmision: '01-04-2020',
    RNCComprador: '131234567',
    RazonSocialComprador: 'Empresa Compradora SRL',
    TipoPago: 1,
    _items: {
      1: { NombreItem: 'Servicio', CantidadItem: 1, PrecioUnitarioItem: 1000, TasaITBIS: 18 },
    },
    ...overrides,
  } as unknown as ExcelRow;
}

describe('mapE31', () => {
  it('sets ecfType to E31', () => {
    expect(mapE31(makeE31Row(), 'c').ecfType).toBe('E31');
  });

  it('maps buyer RNC', () => {
    const dto = mapE31(makeE31Row(), 'c') as any;
    expect(dto.buyer.rnc).toBe('131234567');
  });

  it('includes additionalInfo when FechaEmbarque is present', () => {
    const dto = mapE31(makeE31Row({ FechaEmbarque: '15-04-2020' }), 'c') as any;
    expect(dto.additionalInfo).toBeDefined();
    expect(dto.additionalInfo.shipmentDate).toBe('15-04-2020');
  });

  it('omits additionalInfo when no transport fields present', () => {
    const dto = mapE31(makeE31Row(), 'c') as any;
    expect(dto.additionalInfo).toBeUndefined();
  });

  it('includes transport when Conductor is present', () => {
    const dto = mapE31(makeE31Row({ Conductor: 'Juan Pérez', Placa: 'A123456' }), 'c') as any;
    expect(dto.transport).toBeDefined();
    expect(dto.transport.conductor).toBe('Juan Pérez');
    expect(dto.transport.placa).toBe('A123456');
  });

  it('omits transport when no transport fields present', () => {
    const dto = mapE31(makeE31Row(), 'c') as any;
    expect(dto.transport).toBeUndefined();
  });

  it('sets encfOverride to 1 for E310000000001', () => {
    expect((mapE31(makeE31Row(), 'c') as any).encfOverride).toBe(1);
  });
});
