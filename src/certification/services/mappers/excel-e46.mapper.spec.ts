/**
 * E46 mapper — unit tests (Comprobante de Exportaciones).
 *
 * Fix 4g pins down that the common DGII transport fields (DocumentoTransporte,
 * Ficha, RutaTransporte, ZonaTransporte) are read from the Excel and forwarded
 * to the builder. The pre-Fix 4g mapper omitted them entirely, causing every
 * E46 in certification to be rejected with "enviado () no coincide con
 * (363636)" etc.
 */
import { mapE46 } from './excel-e46.mapper';
import { ExcelRow } from './excel-mapper.interface';

function makeE46Row(overrides: Partial<Record<string, unknown>> = {}): ExcelRow {
  return {
    TipoeCF: 46,
    eNCF: 'E460000000009',
    FechaEmision: '01-04-2020',
    RNCComprador: '131234567',
    RazonSocialComprador: 'Comprador Exportador SRL',
    TipoPago: 1,
    _items: {
      1: { NombreItem: 'Mercancia', CantidadItem: 1, PrecioUnitarioItem: 117500 },
    },
    ...overrides,
  } as unknown as ExcelRow;
}

describe('mapE46', () => {
  it('sets ecfType to E46', () => {
    expect(mapE46(makeE46Row(), 'c').ecfType).toBe('E46');
  });

  describe('Fix 4g: transport common fields', () => {
    it('reads DocumentoTransporte, Ficha, RutaTransporte, ZonaTransporte from Excel', () => {
      const dto = mapE46(makeE46Row({
        DocumentoTransporte: '363636',
        Ficha: 'J-1234',
        RutaTransporte: 'B-Sur',
        ZonaTransporte: 'Interior-1',
      }), 'c') as any;

      expect(dto.transport.documentoTransporte).toBe(363636);
      expect(dto.transport.ficha).toBe('J-1234');
      expect(dto.transport.rutaTransporte).toBe('B-Sur');
      expect(dto.transport.zonaTransporte).toBe('Interior-1');
    });

    it('omits transport fields that are absent or "#e"', () => {
      const dto = mapE46(makeE46Row({
        DocumentoTransporte: '#e',
        Ficha: '',
        // RutaTransporte not set at all
        // ZonaTransporte not set at all
      }), 'c') as any;

      expect(dto.transport.documentoTransporte).toBeUndefined();
      expect(dto.transport.ficha).toBeUndefined();
      expect(dto.transport.rutaTransporte).toBeUndefined();
      expect(dto.transport.zonaTransporte).toBeUndefined();
    });

    it('preserves the original Conductor/Placa fields (no regression)', () => {
      const dto = mapE46(makeE46Row({
        Conductor: 'Juan Perez',
        Placa: 'A123456',
        DocumentoTransporte: '363636',
      }), 'c') as any;

      expect(dto.transport.conductor).toBe('Juan Perez');
      expect(dto.transport.placa).toBe('A123456');
      expect(dto.transport.documentoTransporte).toBe(363636);
    });
  });
});
