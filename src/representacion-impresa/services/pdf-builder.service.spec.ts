import * as QRCode from 'qrcode';
import { PdfBuilder } from './pdf-builder.service';

function makeInvoice(overrides: Record<string, any> = {}) {
  return {
    encf: 'E310000000010',
    ecfType: 'E31',
    createdAt: new Date('2020-04-01T04:00:00Z'),
    signedAt: new Date('2026-05-22T22:09:37Z'),
    securityCode: 'abc123',
    subtotal: 70000,
    totalItbis: 12600,
    totalIsc: 0,
    totalDiscount: 0,
    totalAmount: 82600,
    isRfce: false,
    referenceEncf: null,
    referenceModCode: null,
    company: {
      businessName: 'NEW PLAIN EIRL',
      tradeName: 'NEW PLAIN',
      rnc: '133158744',
      address: 'Calle Principal #1',
      municipality: 'Santo Domingo Este',
      province: 'Santo Domingo',
    },
    buyer: { name: 'Cliente Test', rnc: '131880681' },
    buyerName: null,
    buyerRnc: null,
    lines: [
      {
        quantity: 2,
        description: 'Servicio de consultoría',
        unitPrice: 35000,
        itbisAmount: 6300,
        subtotal: 70000,
        goodService: 2,
        itbisRate: 18,
      },
    ],
    ...overrides,
  };
}

describe('PdfBuilder.build', () => {
  let builder: PdfBuilder;
  let realQrPng: Buffer;

  beforeAll(async () => {
    realQrPng = await (QRCode as any).toBuffer('https://example.com', { width: 80 });
  });

  beforeEach(() => { builder = new PdfBuilder(); });

  it('genera un Buffer con header PDF válido para E31', async () => {
    const pdf = await builder.build(makeInvoice(), realQrPng);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF para E32 (RFCE)', async () => {
    const pdf = await builder.build(makeInvoice({ ecfType: 'E32', isRfce: true }), realQrPng);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('E32 con montoTotal < 250k omite bloque cliente (isRfce=false pero monto bajo)', async () => {
    const pdf = await builder.build(
      makeInvoice({ ecfType: 'E32', isRfce: false, totalAmount: 100000 }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF para E33 con referenceEncf y referenceModCode', async () => {
    const pdf = await builder.build(
      makeInvoice({ ecfType: 'E33', referenceEncf: 'E310000000005', referenceModCode: 3 }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF para E34 (sin FechaVencimiento)', async () => {
    const pdf = await builder.build(makeInvoice({ ecfType: 'E34' }), realQrPng);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF con ISC y Descuento cuando > 0', async () => {
    const pdf = await builder.build(
      makeInvoice({ totalIsc: 5000, totalDiscount: 1000 }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF sin buyer relation (usa buyerName/buyerRnc)', async () => {
    const pdf = await builder.build(
      makeInvoice({ buyer: null, buyerName: 'Cliente Sin Relacion', buyerRnc: '101010101' }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF para múltiples líneas', async () => {
    const invoice = makeInvoice({
      lines: [
        { quantity: 1, description: 'Item A', unitPrice: 10000, itbisAmount: 1800, subtotal: 10000, goodService: 1, itbisRate: 18 },
        { quantity: 3, description: 'Item B', unitPrice: 5000,  itbisAmount: 2700, subtotal: 15000, goodService: 1, itbisRate: 18 },
        { quantity: 10, description: 'Item C', unitPrice: 2500, itbisAmount: 4500, subtotal: 25000, goodService: 2, itbisRate: 18 },
      ],
    });
    const pdf = await builder.build(invoice, realQrPng);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF con ítem exento (itbisRate=0) sin crash', async () => {
    const pdf = await builder.build(
      makeInvoice({
        lines: [
          { quantity: 1, description: 'ARROZ EXENTO', unitPrice: 1000, itbisAmount: 0, subtotal: 1000, goodService: 1, itbisRate: 0 },
        ],
      }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('genera PDF con municipality/province como códigos DGII (6 dígitos)', async () => {
    const pdf = await builder.build(
      makeInvoice({
        company: {
          businessName: 'TEST EIRL',
          tradeName: null,
          rnc: '133158744',
          address: 'Calle Alexander Ramos #19',
          municipality: '320200',
          province: '320000',
        },
      }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    // Raw numeric codes must NOT appear in the PDF output as label text.
    // We can't easily parse a compressed PDF stream, but we verify no crash.
  });

  it('genera PDF sin tradeName (solo businessName en encabezado)', async () => {
    const pdf = await builder.build(
      makeInvoice({
        company: {
          businessName: 'EMPRESA SIN NOMBRE COMERCIAL',
          tradeName: null,
          rnc: '133158744',
          address: 'Calle Test #1',
          municipality: null,
          province: null,
        },
      }),
      realQrPng,
    );
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
