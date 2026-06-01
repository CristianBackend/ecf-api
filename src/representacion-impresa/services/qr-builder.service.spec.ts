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

    it('FechaFirma codifica el espacio como %20 (DGII spec v1.6 pág. 58)', () => {
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

    it('MontoTotal string del XML se usa byte-por-byte sin reformatear', () => {
      // Simulates the XML value extracted when exempt items differ from totalAmount
      const url = qr.buildUrl({ isRfce: false, dgiiEnv: 'CERT', rncEmisor: '133', encf: 'E310000000005', fechaEmision: FIXED_DATE, montoTotal: '83320.00', fechaFirma: FIXED_FIRMA, codigoSeguridad: 'abc' });
      expect(url).toContain('MontoTotal=83320.00');
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

describe('QrBuilder — timezone (América/Santo_Domingo = UTC-4)', () => {
  let qr: QrBuilder;
  beforeEach(() => { qr = new QrBuilder(); });

  it('uses Dominican timezone (UTC-4) for FechaFirma in QR url', () => {
    // From production DB: signed_at stored as UTC 2026-05-23T04:44:45Z
    // → Dominican local time: 2026-05-23 00:44:45
    const signedAtUtc = new Date('2026-05-23T04:44:45.695Z');

    const url = qr.buildUrl({
      isRfce: false,
      dgiiEnv: 'CERT',
      rncEmisor: '133158744',
      rncComprador: '131880681',
      encf: 'E470000000001',
      fechaEmision: signedAtUtc,
      montoTotal: 1000.00,
      fechaFirma: signedAtUtc,
      codigoSeguridad: 'DF2486',
    });

    // Must match <FechaHoraFirma> in XML (Dominican local), NOT raw UTC.
    // Fully encodeURIComponent'd like the official dgii-ecf lib: space → %20, ':' → %3A.
    expect(url).toContain('FechaFirma=23-05-2026%2000%3A44%3A45');
    expect(url).not.toContain('FechaFirma=23-05-2026%2004%3A44%3A45');
  });

  it('uses Dominican timezone for FechaEmision in QR url', () => {
    // createdAt stored as UTC 2026-05-23T04:44:45Z → Dominican: 23-05-2026
    const createdAtUtc = new Date('2026-05-23T04:44:45Z');

    const url = qr.buildUrl({
      isRfce: false,
      dgiiEnv: 'CERT',
      rncEmisor: '133158744',
      rncComprador: '131880681',
      encf: 'E450000000001',
      fechaEmision: createdAtUtc,
      montoTotal: 500.00,
      fechaFirma: createdAtUtc,
      codigoSeguridad: 'DF2486',
    });

    expect(url).toContain('FechaEmision=23-05-2026');
  });

  it('RFCE QR does not include FechaFirma even with UTC date', () => {
    const signedAtUtc = new Date('2026-05-23T04:44:45Z');

    const url = qr.buildUrl({
      isRfce: true,
      dgiiEnv: 'CERT',
      rncEmisor: '133158744',
      encf: 'E320000000001',
      fechaEmision: signedAtUtc,
      montoTotal: 5000.00,
      fechaFirma: signedAtUtc,
      codigoSeguridad: 'DF2486',
    });

    expect(url).not.toContain('FechaFirma');
    expect(url).not.toContain('FechaEmision');
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
