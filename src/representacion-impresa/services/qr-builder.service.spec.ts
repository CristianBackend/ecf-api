import { QrBuilder } from './qr-builder.service';

const FIXED_DATE = new Date('2020-04-01T04:00:00Z'); // midnight Santo Domingo (UTC-4)
const FIXED_FIRMA = new Date('2026-05-22T22:09:37Z');

describe('QrBuilder.buildUrl', () => {
  let qr: QrBuilder;

  beforeEach(() => { qr = new QrBuilder(); });

  describe('e-CF normal (isRfce=false)', () => {
    it('DEV → testecf base URL', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'DEV', rncEmisor: '133', rncComprador: '131', encf: 'E31001', fechaEmision: FIXED_DATE, montoTotal: 100, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'abc' });
      expect(url).toContain('https://ecf.dgii.gov.do/testecf/ConsultaTimbre?');
    });

    it('CERT → certecf base URL', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'CERT', rncEmisor: '133', rncComprador: '131', encf: 'E310000000010', fechaEmision: FIXED_DATE, montoTotal: 83320.00, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'abc123' });
      expect(url).toContain('https://ecf.dgii.gov.do/certecf/ConsultaTimbre?');
      expect(url).toContain('RncEmisor=133');
      expect(url).toContain('RncComprador=131');
      expect(url).toContain('ENCF=E310000000010');
      expect(url).toContain('MontoTotal=83320.00');
      expect(url).toContain('CodigoSeguridad=abc123');
    });

    it('PROD → ecf base URL', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'PROD', rncEmisor: '133', encf: 'E31001', fechaEmision: FIXED_DATE, montoTotal: 100, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'xyz' });
      expect(url).toContain('https://ecf.dgii.gov.do/ecf/ConsultaTimbre?');
    });

    it('FechaFirma contiene %20 en vez de espacio', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'CERT', rncEmisor: '133', encf: 'E31001', fechaEmision: FIXED_DATE, montoTotal: 100, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'x' });
      expect(url).toContain('%20');
      expect(url).not.toMatch(/FechaFirma=\d{2}-\d{2}-\d{4} /); // no espacio literal
    });

    it('omite RncComprador cuando no se proporciona', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'CERT', rncEmisor: '133', encf: 'E41001', fechaEmision: FIXED_DATE, montoTotal: 5000, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'x' });
      expect(url).not.toContain('RncComprador');
    });

    it('MontoTotal tiene exactamente 2 decimales', () => {
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'CERT', rncEmisor: '133', encf: 'E31001', fechaEmision: FIXED_DATE, montoTotal: 1500, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'x' });
      expect(url).toContain('MontoTotal=1500.00');
    });
  });

  describe('RFCE E32 <250mil (isRfce=true)', () => {
    it('DEV → TesteCF base URL', () => {
      const url = qr.buildUrl({ isRfce: true, dgiiEnv: 'DEV', rncEmisor: '133', encf: 'E32001', fechaEmision: FIXED_DATE, montoTotal: 5000, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'abc' });
      expect(url).toContain('https://fc.dgii.gov.do/TesteCF/ConsultaTimbreFC?');
    });

    it('CERT → CerteCF base URL con 4 params solamente', () => {
      const url = qr.buildUrl({ isRfce: true, dgiiEnv: 'CERT', rncEmisor: '133158744', encf: 'E320000000004', fechaEmision: FIXED_DATE, montoTotal: 5000.00, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'abc123' });
      expect(url).toContain('https://fc.dgii.gov.do/CerteCF/ConsultaTimbreFC?');
      expect(url).toContain('RncEmisor=133158744');
      expect(url).toContain('ENCF=E320000000004');
      expect(url).toContain('MontoTotal=5000.00');
      expect(url).toContain('CodigoSeguridad=abc123');
      expect(url).not.toContain('RncComprador');
      expect(url).not.toContain('FechaEmision');
      expect(url).not.toContain('FechaFirma');
    });

    it('PROD → eCF base URL', () => {
      const url = qr.buildUrl({ isRfce: true, dgiiEnv: 'PROD', rncEmisor: '133', encf: 'E32001', fechaEmision: FIXED_DATE, montoTotal: 999, fechaFirma: FIXED_FIRMA, codigoSeguridad: 'x' });
      expect(url).toContain('https://fc.dgii.gov.do/eCF/ConsultaTimbreFC?');
    });
  });
});

describe('QrBuilder.buildImage', () => {
  it('retorna Buffer PNG válido', async () => {
    const qr = new QrBuilder();
    const buf = await qr.buildImage('https://example.com', 200);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(100);
    // PNG magic bytes: 89 50 4E 47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });
});
