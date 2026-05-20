/**
 * base-excel.mapper — regression tests
 *
 * These tests pin down the field name conventions used in the DGII
 * certification Excel set, where mismatches silently dropped data
 * before Fix 4a (e.g. `BienOServicio` vs the real `IndicadorBienoServicio`).
 */
import { mapItem, mapAdditionalInfo, mapBase } from './base-excel.mapper';

describe('base-excel.mapper', () => {
  describe('mapItem', () => {
    it('reads goodService from IndicadorBienoServicio (real Excel header), not BienOServicio', () => {
      // BUG (pre-Fix 4a): the mapper read `BienOServicio`, which doesn't exist
      // in the DGII Excel. The real header is `IndicadorBienoServicio` (one 'o').
      // Result: every item had goodService=undefined, the builder omitted
      // IndicadorBienoServicio, and DGII rejected E43/E44/E47 with
      // "valor enviado (1) no coincide con valor (2)".
      const item = {
        NombreItem: 'Servicio profesional',
        CantidadItem: '1.00',
        PrecioUnitarioItem: '10000.0000',
        IndicadorBienoServicio: '2',
        IndicadorFacturacion: '4',
      };
      const mapped = mapItem(item);
      expect(mapped.goodService).toBe(2);
    });

    it('returns goodService undefined when IndicadorBienoServicio is absent', () => {
      const item = { NombreItem: 'X', CantidadItem: '1', PrecioUnitarioItem: '1' };
      const mapped = mapItem(item);
      expect(mapped.goodService).toBeUndefined();
    });

    it('ignores the wrong BienOServicio header even if forged in input (regression guard)', () => {
      // Regression guard: ensure the mapper does NOT regress to the old buggy
      // `BienOServicio` read. If someone happens to pass that field, it must
      // not leak into goodService.
      const item = {
        NombreItem: 'X',
        CantidadItem: '1',
        PrecioUnitarioItem: '1',
        BienOServicio: '99',          // wrong header — must be ignored
        IndicadorBienoServicio: '1',  // correct header — should win
      };
      const mapped = mapItem(item);
      expect(mapped.goodService).toBe(1);
    });
  });

  describe('mapAdditionalInfo', () => {
    it('lifts PesoBruto/PesoNeto/CantidadBulto/VolumenBulto and their unit codes', () => {
      // The DGII test set for E310000000005 sends:
      //   PesoBruto='25.00', PesoNeto='24.50', UnidadPesoBruto='23',
      //   UnidadPesoNeto='23', CantidadBulto='1.00', UnidadBulto='6',
      //   VolumenBulto='1.00', UnidadVolumen='6'
      // Pre-Fix 4a these were ignored and DGII rejected with
      // "El campo PesoNeto del área InformacionesAdicionales no es válido".
      const row = {
        _items: {},
        PesoBruto: '25.00',
        PesoNeto: '24.50',
        UnidadPesoBruto: '23',
        UnidadPesoNeto: '23',
        CantidadBulto: '1.00',
        UnidadBulto: '6',
        VolumenBulto: '1.00',
        UnidadVolumen: '6',
      } as any;

      const info = mapAdditionalInfo(row);
      expect(info).toEqual({
        grossWeight: 25,
        netWeight: 24.5,
        grossWeightUnit: 23,
        netWeightUnit: 23,
        packageCount: 1,
        packageUnit: 6,
        packageVolume: 1,
        volumeUnit: 6,
      });
    });

    it('returns undefined when no weight/package/volume fields are present', () => {
      const row = { _items: {} } as any;
      expect(mapAdditionalInfo(row)).toBeUndefined();
    });

    it('strips undefined fields so the builder can omit absent ones', () => {
      const row = {
        _items: {},
        PesoNeto: '50.00',
        // UnidadPesoNeto absent
      } as any;
      const info = mapAdditionalInfo(row) as any;
      expect(info).toEqual({ netWeight: 50 });
      expect(info).not.toHaveProperty('netWeightUnit');
    });
  });

  // ===========================================================================
  // Fix 4f — verbatim decimal strings (rawText)
  // ===========================================================================

  describe('mapItem rawText (Fix 4f)', () => {
    it('preserves the EXACT decimal precision from the Excel cell', () => {
      // Real DGII test set values that previously triggered rejection.
      const item = {
        NombreItem: 'X',
        CantidadItem: '7.00',
        PrecioUnitarioItem: '100.00',
        MontoItem: '700.00',
      };
      const mapped = mapItem(item) as any;

      // Numeric values still flow for totals math.
      expect(mapped.quantity).toBe(7);
      expect(mapped.unitPrice).toBe(100);

      // The verbatim strings are preserved so the builder can emit them as-is.
      expect(mapped.rawText.CantidadItem).toBe('7.00');
      expect(mapped.rawText.PrecioUnitarioItem).toBe('100.00');
      expect(mapped.rawText.MontoItem).toBe('700.00');
    });

    it('preserves "1" (no decimal) and "10000.0000" (4 decimals) verbatim', () => {
      // E430000000012: CantidadItem is exactly '1' (no decimals);
      // PrecioUnitarioItem is '10000.0000' (4 decimals).
      const item = {
        NombreItem: 'X',
        CantidadItem: '1',
        PrecioUnitarioItem: '10000.0000',
      };
      const mapped = mapItem(item) as any;
      expect(mapped.rawText.CantidadItem).toBe('1');
      expect(mapped.rawText.PrecioUnitarioItem).toBe('10000.0000');
      expect(mapped.quantity).toBe(1);     // still parsed for math
      expect(mapped.unitPrice).toBe(10000);
    });

    it('omits rawText when no fields parsed as numeric strings', () => {
      const item = { NombreItem: 'X' };
      const mapped = mapItem(item) as any;
      expect(mapped.rawText).toBeUndefined();
    });

    it('omits non-numeric cells like "#e" from rawText (no garbage emitted)', () => {
      const item = {
        NombreItem: 'X',
        CantidadItem: '1.00',
        PrecioUnitarioItem: '#e',  // empty sentinel
      };
      const mapped = mapItem(item) as any;
      expect(mapped.rawText.CantidadItem).toBe('1.00');
      // PrecioUnitarioItem should NOT be in rawText because it's '#e'
      expect(mapped.rawText.PrecioUnitarioItem).toBeUndefined();
    });

    it('preserves PrecioOtraMoneda verbatim (E45 quirk: 26.64 vs 26.6430)', () => {
      // E450000000010 was rejected because DGII expected 26.64 but we emitted
      // 26.6430 (computed from price/exchangeRate at 4 decimals).
      const item = {
        NombreItem: 'X',
        CantidadItem: '20.00',
        PrecioUnitarioItem: '1500.0000',
        PrecioOtraMoneda: '26.64',
      };
      const mapped = mapItem(item) as any;
      expect(mapped.rawText.PrecioOtraMoneda).toBe('26.64');
    });

    it('rejects non-numeric strings (dates, text) so they never leak to XML', () => {
      const item = {
        NombreItem: 'X',
        CantidadItem: 'not-a-number',
        PrecioUnitarioItem: '10-2026',  // date-like
      };
      const mapped = mapItem(item) as any;
      // Neither should appear in rawText
      expect(mapped.rawText).toBeUndefined();
    });
  });

  // ===========================================================================
  // Fix 4g — header-level totals via totalsRawText
  // ===========================================================================

  describe('mapBase totalsRawText (Fix 4g)', () => {
    // Minimal helpers to build a fake ExcelRow for mapBase.
    function row(extra: Record<string, unknown> = {}) {
      return {
        eNCF: 'E310000000005',
        TipoeCF: 31,
        _items: {
          1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 1 },
        },
        FechaEmision: '01-01-2020',
        // The minimum buyer fields so mapBuyer doesn't blow up
        RNCComprador: '101000001',
        RazonSocialComprador: 'TEST',
        ...extra,
      } as any;
    }

    // mapBase imported at top of file.

    it('builds totalsRawText from Excel headers when totals are present', () => {
      const out = mapBase(row({
        MontoGravadoTotal: '70522.19',
        MontoGravadoI1: '622.88',
        MontoGravadoI2: '69129.31',
        MontoGravadoI3: '770.00',
        MontoExento: '1625.00',
        ITBIS1: '18',
        ITBIS2: '16',
        ITBIS3: '0',
        TotalITBIS: '11172.81',
        TotalITBIS1: '112.12',
        TotalITBIS2: '11060.69',
        TotalITBIS3: '0.00',
        MontoTotal: '83320.00',
      }), 'company-1', 'E31');

      expect(out.totalsRawText).toBeDefined();
      const r = out.totalsRawText as Record<string, string>;
      expect(r.MontoGravadoI1).toBe('622.88');
      expect(r.MontoGravadoI2).toBe('69129.31');
      expect(r.MontoGravadoI3).toBe('770.00');
      expect(r.MontoExento).toBe('1625.00');
      expect(r.ITBIS3).toBe('0');
      expect(r.TotalITBIS3).toBe('0.00');
      expect(r.MontoTotal).toBe('83320.00');
    });

    it('omits totalsRawText entirely when NO totals are present in the row', () => {
      const out = mapBase(row(), 'company-1', 'E31');
      expect(out.totalsRawText).toBeUndefined();
    });

    it('only includes fields that have valid numeric strings ("#e" → skip)', () => {
      const out = mapBase(row({
        MontoTotal: '500.00',
        MontoNoFacturable: '#e',     // empty sentinel
        TotalITBISRetenido: '',       // empty string
      }), 'company-1', 'E31');

      const r = out.totalsRawText as Record<string, string>;
      expect(r.MontoTotal).toBe('500.00');
      expect(r.MontoNoFacturable).toBeUndefined();
      expect(r.TotalITBISRetenido).toBeUndefined();
    });

    it('reads retention totals (E41 case)', () => {
      const out = mapBase(row({
        TotalITBISRetenido: '1800.00',
        TotalISRRetencion: '1000.00',
        MontoTotal: '11800.00',
      }), 'company-1', 'E41');

      const r = out.totalsRawText as Record<string, string>;
      expect(r.TotalITBISRetenido).toBe('1800.00');
      expect(r.TotalISRRetencion).toBe('1000.00');
      expect(r.MontoTotal).toBe('11800.00');
    });

    it('reads E34 NC corrección de texto case (MontoTotal=0, MontoNoFacturable>0)', () => {
      const out = mapBase(row({
        MontoTotal: '0.00',
        MontoNoFacturable: '1.00',
      }), 'company-1', 'E34');

      const r = out.totalsRawText as Record<string, string>;
      expect(r.MontoTotal).toBe('0.00');
      expect(r.MontoNoFacturable).toBe('1.00');
    });
  });
});
