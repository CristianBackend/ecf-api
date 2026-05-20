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

  // ---------------------------------------------------------------------
  // Fix 4h: weight/package/volume units must reach the builder.
  //
  // Pre-Fix 4h, mapE31 built its OWN additionalInfo block that only kept
  // grossWeight/netWeight, dropping the unit/package/volume fields that
  // mapBase already had read via mapAdditionalInfo. DGII then rejected
  // E310000000005 with "UnidadPesoBruto enviado () no coincide con (23)"
  // for every missing unit field.
  // ---------------------------------------------------------------------
  describe('additionalInfo full set (Fix 4h)', () => {
    it('keeps grossWeightUnit, netWeightUnit, packageCount, packageUnit, packageVolume, volumeUnit', () => {
      const dto = mapE31(makeE31Row({
        PesoBruto: '25.00',
        PesoNeto: '24.50',
        UnidadPesoBruto: '23',
        UnidadPesoNeto: '23',
        CantidadBulto: '1.00',
        UnidadBulto: '6',
        VolumenBulto: '1.00',
        UnidadVolumen: '6',
      }), 'c') as any;

      expect(dto.additionalInfo.grossWeight).toBe(25);
      expect(dto.additionalInfo.netWeight).toBe(24.5);
      expect(dto.additionalInfo.grossWeightUnit).toBe(23);
      expect(dto.additionalInfo.netWeightUnit).toBe(23);
      expect(dto.additionalInfo.packageCount).toBe(1);
      expect(dto.additionalInfo.packageUnit).toBe(6);
      expect(dto.additionalInfo.packageVolume).toBe(1);
      expect(dto.additionalInfo.volumeUnit).toBe(6);
    });

    it('omits unit fields that are "#e" or absent in the Excel', () => {
      const dto = mapE31(makeE31Row({
        PesoBruto: '25.00',
        UnidadPesoBruto: '#e',
        // packageCount and friends not set
      }), 'c') as any;

      expect(dto.additionalInfo.grossWeight).toBe(25);
      expect(dto.additionalInfo.grossWeightUnit).toBeUndefined();
      expect(dto.additionalInfo.packageCount).toBeUndefined();
    });
  });
});
