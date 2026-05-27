import { extractXmlField, parseDgiiDate } from './xml-extractors';

describe('xml-extractors', () => {
  describe('extractXmlField', () => {
    it('extracts a simple tag value', () => {
      const xml = '<FechaEmision>01-04-2020</FechaEmision>';
      expect(extractXmlField(xml, 'FechaEmision')).toBe('01-04-2020');
    });

    it('returns null when tag is missing', () => {
      expect(extractXmlField('<Other>x</Other>', 'FechaEmision')).toBeNull();
    });

    it('handles tags with attributes (DGII XML)', () => {
      const xml = '<FechaEmision xmlns="urn:dgii.gov.do">01-04-2020</FechaEmision>';
      expect(extractXmlField(xml, 'FechaEmision')).toBe('01-04-2020');
    });

    it('returns the first occurrence when multiple exist', () => {
      const xml = '<MontoTotal>100</MontoTotal><Detail><MontoTotal>50</MontoTotal></Detail>';
      expect(extractXmlField(xml, 'MontoTotal')).toBe('100');
    });

    it('trims whitespace around the value', () => {
      const xml = '<FechaVencimientoSecuencia>  31-12-2028  </FechaVencimientoSecuencia>';
      expect(extractXmlField(xml, 'FechaVencimientoSecuencia')).toBe('31-12-2028');
    });

    it('extracts FechaHoraFirma value', () => {
      const xml = '<FechaHoraFirma>23-05-2026 00:44:42</FechaHoraFirma>';
      expect(extractXmlField(xml, 'FechaHoraFirma')).toBe('23-05-2026 00:44:42');
    });
  });

  describe('parseDgiiDate', () => {
    it('parses dd-MM-yyyy correctly', () => {
      const d = parseDgiiDate('01-04-2020');
      expect(d).not.toBeNull();
      expect(d!.getFullYear()).toBe(2020);
      expect(d!.getMonth()).toBe(3); // April = 3
      expect(d!.getDate()).toBe(1);
    });

    it('parses a date in 2028', () => {
      const d = parseDgiiDate('31-12-2028');
      expect(d).not.toBeNull();
      expect(d!.getFullYear()).toBe(2028);
      expect(d!.getMonth()).toBe(11); // December = 11
      expect(d!.getDate()).toBe(31);
    });

    it('returns null for ISO format (wrong format)', () => {
      expect(parseDgiiDate('2020-04-01')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(parseDgiiDate(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseDgiiDate(undefined)).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(parseDgiiDate('garbage')).toBeNull();
    });
  });
});
