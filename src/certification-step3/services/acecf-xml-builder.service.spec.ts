/**
 * AcecfXmlBuilder — unit tests for Step 3 ACECF XML generation.
 *
 * Verifies strict xs:sequence order, field presence/absence rules,
 * and format compliance per the official DGII ACECF XSD.
 */
import { AcecfXmlBuilder, Step3AcecfInput } from './acecf-xml-builder.service';
import { makeTestLogger } from '../../common/logger/test-logger';

function makeBuilder() {
  return new AcecfXmlBuilder(makeTestLogger() as any);
}

function baseInput(overrides: Partial<Step3AcecfInput> = {}): Step3AcecfInput {
  return {
    emitterRnc: '131880681',
    receiverRnc: '133158744',
    encf: 'E310000000005',
    issueDate: '01-04-2020',
    totalAmount: 83320.00,
    approved: true,
    approvalDatetime: '22-05-2026 22:09:37',
    ...overrides,
  };
}

describe('AcecfXmlBuilder.buildXml', () => {
  it('contains the ACECF root with correct xmlns attributes', () => {
    const builder = makeBuilder();
    const xml = builder.buildXml(baseInput());
    expect(xml).toContain('<ACECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">');
  });

  it('follows strict xs:sequence: RNCEmisor → eNCF → FechaEmision → MontoTotal → RNCComprador → Estado → FechaHoraAprobacionComercial', () => {
    const builder = makeBuilder();
    const xml = builder.buildXml(baseInput());

    const pos = (tag: string) => xml.indexOf(`<${tag}>`);
    expect(pos('Version')).toBeLessThan(pos('RNCEmisor'));
    expect(pos('RNCEmisor')).toBeLessThan(pos('eNCF'));
    expect(pos('eNCF')).toBeLessThan(pos('FechaEmision'));
    expect(pos('FechaEmision')).toBeLessThan(pos('MontoTotal'));
    expect(pos('MontoTotal')).toBeLessThan(pos('RNCComprador'));
    expect(pos('RNCComprador')).toBeLessThan(pos('Estado'));
    expect(pos('Estado')).toBeLessThan(pos('FechaHoraAprobacionComercial'));
  });

  it('emits Estado=1 when approved=true', () => {
    const xml = makeBuilder().buildXml(baseInput({ approved: true }));
    expect(xml).toContain('<Estado>1</Estado>');
  });

  it('emits Estado=2 and DetalleMotivoRechazo when approved=false', () => {
    const xml = makeBuilder().buildXml(baseInput({
      approved: false,
      rejectionReason: 'Datos incorrectos',
    }));
    expect(xml).toContain('<Estado>2</Estado>');
    expect(xml).toContain('<DetalleMotivoRechazo>Datos incorrectos</DetalleMotivoRechazo>');
  });

  it('does NOT emit DetalleMotivoRechazo when approved=true', () => {
    const xml = makeBuilder().buildXml(baseInput({ approved: true }));
    expect(xml).not.toContain('<DetalleMotivoRechazo>');
  });

  it('does NOT emit MontoITBIS (not in official XSD)', () => {
    const xml = makeBuilder().buildXml(baseInput());
    expect(xml).not.toContain('MontoITBIS');
  });

  it('formats MontoTotal with exactly 2 decimal places', () => {
    const xml = makeBuilder().buildXml(baseInput({ totalAmount: 83320 }));
    expect(xml).toContain('<MontoTotal>83320.00</MontoTotal>');
  });

  it('formats zero amount as 0.00', () => {
    const xml = makeBuilder().buildXml(baseInput({ totalAmount: 0 }));
    expect(xml).toContain('<MontoTotal>0.00</MontoTotal>');
  });

  it('emits issueDate verbatim — no timezone conversion applied', () => {
    // Previously a Date object was formatted through GMT-4, causing off-by-one
    // when the DB returned a UTC midnight Date. Now issueDate is always a string.
    const xml = makeBuilder().buildXml(baseInput({ issueDate: '01-04-2020' }));
    expect(xml).toContain('<FechaEmision>01-04-2020</FechaEmision>');
  });

  it('preserves exact FechaEmision string from input (regression: was shifting by UTC offset)', () => {
    const xml = makeBuilder().buildXml(baseInput({ issueDate: '02-12-2018' }));
    expect(xml).toContain('<FechaEmision>02-12-2018</FechaEmision>');
  });

  it('emits FechaHoraAprobacionComercial verbatim from input.approvalDatetime', () => {
    const xml = makeBuilder().buildXml(baseInput({ approvalDatetime: '22-05-2026 22:09:37' }));
    expect(xml).toContain('<FechaHoraAprobacionComercial>22-05-2026 22:09:37</FechaHoraAprobacionComercial>');
  });

  it('uses the exact Excel string for FechaHoraAprobacionComercial (not current time)', () => {
    const fixed = '01-04-2020 10:09:37';
    const xml = makeBuilder().buildXml(baseInput({ approvalDatetime: fixed }));
    expect(xml).toContain(`<FechaHoraAprobacionComercial>${fixed}</FechaHoraAprobacionComercial>`);
  });

  it('escapes XML special chars in rejectionReason', () => {
    const xml = makeBuilder().buildXml(baseInput({
      approved: false,
      rejectionReason: 'Error & <datos>',
    }));
    expect(xml).toContain('Error &amp; &lt;datos&gt;');
  });

  it('uses default rejection reason when rejectionReason is undefined and approved=false', () => {
    const xml = makeBuilder().buildXml(baseInput({ approved: false }));
    expect(xml).toContain('<DetalleMotivoRechazo>Rechazado por el comprador</DetalleMotivoRechazo>');
  });

  it('emits the RNCEmisor and RNCComprador from input', () => {
    const xml = makeBuilder().buildXml(baseInput());
    expect(xml).toContain('<RNCEmisor>131880681</RNCEmisor>');
    expect(xml).toContain('<RNCComprador>133158744</RNCComprador>');
  });

  it('DetalleMotivoRechazo comes before FechaHoraAprobacionComercial when Estado=2', () => {
    const xml = makeBuilder().buildXml(baseInput({ approved: false, rejectionReason: 'test' }));
    expect(xml.indexOf('<DetalleMotivoRechazo>')).toBeLessThan(xml.indexOf('<FechaHoraAprobacionComercial>'));
  });
});
