import {
  resolveIndicadorFacturacion,
  effectiveItbisRate,
  lineItbisAmount,
  round2,
} from './itbis.util';

describe('itbis.util — shared ITBIS classification (XML builder == persisted InvoiceLine)', () => {
  describe('resolveIndicadorFacturacion', () => {
    it('uses the explicit item value when present', () => {
      expect(resolveIndicadorFacturacion({ indicadorFacturacion: 4 }, 18)).toBe(4);
      expect(resolveIndicadorFacturacion({ indicadorFacturacion: 0 }, 18)).toBe(0);
      expect(resolveIndicadorFacturacion({ indicadorFacturacion: 2 }, 18)).toBe(2);
    });
    it('derives from the ITBIS rate when no explicit indicator', () => {
      expect(resolveIndicadorFacturacion({}, 18)).toBe(1);
      expect(resolveIndicadorFacturacion({}, 16)).toBe(2);
      expect(resolveIndicadorFacturacion({}, 0)).toBe(3);
      expect(resolveIndicadorFacturacion({}, 7)).toBe(1); // default 18%
    });
  });

  describe('effectiveItbisRate — 0/3/4 carry 0%', () => {
    it.each([
      [1, 18],
      [2, 16],
      [3, 0], // ITBIS 0%
      [4, 0], // Exento
      [0, 0], // No Facturable
    ])('indicador %i → effective rate %i%%', (indicador, expected) => {
      expect(effectiveItbisRate(indicador, 18)).toBe(expected);
    });
  });

  describe('lineItbisAmount — respects IndicadorFacturacion (the FIX)', () => {
    it('Exento (4) carries 0 ITBIS even when the line has a default 18% rate', () => {
      expect(lineItbisAmount(1000, 4, 18)).toBe(0);
    });
    it('No Facturable (0) and ITBIS 0% (3) carry 0', () => {
      expect(lineItbisAmount(1000, 0, 18)).toBe(0);
      expect(lineItbisAmount(1000, 3, 0)).toBe(0);
    });
    it('Gravado 18% (1) and 16% (2) carry the correct ITBIS', () => {
      expect(lineItbisAmount(1000, 1, 18)).toBe(180);
      expect(lineItbisAmount(1000, 2, 16)).toBe(160);
      expect(lineItbisAmount(1234.5, 1, 18)).toBe(round2(1234.5 * 0.18)); // 222.21
    });
  });
});
