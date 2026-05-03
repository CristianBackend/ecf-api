import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getLoggerToken } from 'nestjs-pino';
import { PdfService } from './pdf.service';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';

// Stub QRCode so tests don't perform actual image generation
jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,FAKEQRDATA=='),
}));

// ============================================================
// Test fixtures
// ============================================================

const BASE_LINE = {
  lineNumber: 1,
  description: 'Servicio de consultoría',
  quantity: '1.0000',
  unitPrice: '10000.0000',
  discount: '0.00',
  itbisRate: '18.00',
  itbisAmount: '1800.00',
  iscAmount: '0.00',
  subtotal: '10000.00',
};

const BASE_COMPANY = {
  businessName: 'Mi Empresa SRL',
  tradeName: null,
  rnc: '101010101',
  address: 'Calle Principal #1',
  municipality: 'Santo Domingo',
  province: 'Distrito Nacional',
  phone: '809-555-1234',
  dgiiEnv: 'TesteCF',
};

function makeInvoice(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'inv-001',
    tenantId: 'tenant-001',
    ecfType: 'E31',
    encf: 'E310000000001',
    status: 'ACCEPTED',
    buyerRnc: '123456789',
    buyerName: 'Empresa Compradora SRL',
    buyerEmail: null,
    subtotal: '10000.00',
    totalDiscount: '0.00',
    totalItbis: '1800.00',
    totalIsc: '0.00',
    totalAmount: '11800.00',
    paymentType: 1,
    paymentDate: null,
    referenceEncf: null,
    referenceDate: null,
    referenceModCode: null,
    currency: 'DOP',
    exchangeRate: null,
    signedAt: new Date('2026-05-03T15:00:00Z'),
    createdAt: new Date('2026-05-03T15:00:00Z'),
    securityCode: 'ABC123',
    trackId: null,
    metadata: null,
    lines: [BASE_LINE],
    company: BASE_COMPANY,
    ...overrides,
  };
}

// ============================================================
// Suite
// ============================================================

describe('PdfService', () => {
  let service: PdfService;
  let prisma: { invoice: { findFirst: jest.Mock } };

  beforeEach(async () => {
    prisma = { invoice: { findFirst: jest.fn() } };

    const signing = {
      buildQrUrl: jest
        .fn()
        .mockReturnValue('https://ecf.dgii.gov.do/testecf/consultas?test=1'),
    };

    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PdfService,
        { provide: PrismaService, useValue: prisma },
        { provide: SigningService, useValue: signing },
        { provide: getLoggerToken(PdfService.name), useValue: logger },
      ],
    }).compile();

    service = module.get<PdfService>(PdfService);
  });

  // ── 1. Error path ─────────────────────────────────────────────

  it('throws NotFoundException when invoice does not exist', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(service.generateHtml('t1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── 2-11. Fiscal legend per e-CF type ─────────────────────────

  const LEGEND_CASES: Array<[string, string]> = [
    ['E31', 'El ITBIS facturado forma parte de su crédito fiscal'],
    ['E32', 'No aplica como crédito fiscal ni sustento de costos y gastos'],
    ['E33', 'Nota de Débito que modifica el NCF indicado'],
    ['E34', 'Nota de Crédito que modifica el NCF indicado'],
    ['E41', 'El ITBIS facturado es un gasto sujeto a proporcionalidad'],
    ['E43', 'Comprobante de gasto menor'],
    ['E44', 'Régimen especial de tributación'],
    ['E45', 'Documento gubernamental — exento de ITBIS'],
    ['E46', 'Exportación libre de ITBIS conforme Art. 343 Cód. Tributario'],
    ['E47', 'Pago al exterior sujeto a retención'],
  ];

  LEGEND_CASES.forEach(([type, legend]) => {
    it(`${type}: fiscal legend "${legend.slice(0, 40)}…" present in HTML`, async () => {
      prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ ecfType: type }));
      const html = await service.generateHtml('t1', 'inv-001');
      expect(html).toContain(legend);
    });
  });

  // ── 12. Timezone GMT-4 ────────────────────────────────────────

  it('renders dates in GMT-4, not UTC (2026-05-04T02:00Z → 03/05/2026)', async () => {
    // 2026-05-04T02:00:00Z UTC = 2026-05-03T22:00:00 GMT-4 (date = May 3)
    const utcDate = new Date('2026-05-04T02:00:00Z');
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ createdAt: utcDate, signedAt: utcDate }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('03/05/2026');
    expect(html).not.toMatch(/04\/05\/2026/);
  });

  // ── 13. QR embedded as data URL ───────────────────────────────

  it('embeds QR as data:image/png;base64 — no external URL', async () => {
    prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('api.qrserver.com');
  });

  // ── 14. E33 mod code = 1 ─────────────────────────────────────

  it('E33 with referenceModCode=1 shows "Anula Comprobante Fiscal Electrónico"', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E33',
        referenceEncf: 'E310000000001',
        referenceDate: new Date('2026-04-01T12:00:00Z'),
        referenceModCode: 1,
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Anula Comprobante Fiscal Electrónico');
  });

  // ── 15. E34 mod code = 3 ─────────────────────────────────────

  it('E34 with referenceModCode=3 shows "Corrección de Montos"', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E34',
        referenceEncf: 'E310000000001',
        referenceModCode: 3,
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Corrección de Montos');
  });

  // ── 16. E33 without mod code shows warning ───────────────────

  it('E33 without referenceModCode shows warning', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E33',
        referenceEncf: 'E310000000001',
        referenceModCode: null,
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('modificaci');
    expect(html).toContain('no especificado');
  });

  // ── 17. E46 with transport + export data ─────────────────────

  it('E46 with transport data shows Transporte and Información de Exportación sections', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E46',
        metadata: {
          _originalDto: {
            transport: {
              carrierName: 'Naviera DR',
              carrierRnc: '987654321',
              countryDestination: 'US',
              countryOrigin: 'DO',
              viaTransporte: 2,
              tripNumber: 'V-001',
            },
            additionalInfo: {
              deliveryConditions: 'FOB',
              customsRegime: '10',
              portOfShipment: 'Puerto Caucedo',
              totalFob: 50000,
              freight: 1500,
            },
          },
        },
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Transporte');
    expect(html).toContain('Informaci');
    expect(html).toContain('Naviera DR');
    expect(html).toContain('FOB');
    expect(html).toContain('Puerto Caucedo');
  });

  // ── 18. E46 without export data shows placeholders ────────────

  it('E46 without export metadata shows sections with [no especificado]', async () => {
    prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ ecfType: 'E46' }));
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Transporte');
    expect(html).toContain('[no especificado]');
  });

  // ── 19. Non-E46 type does NOT have export sections ────────────

  it('E31 does NOT contain export sections', async () => {
    prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ ecfType: 'E31' }));
    const html = await service.generateHtml('t1', 'inv-001');
    // The export section headings only appear in the E46 body, never for other types
    expect(html).not.toContain('class="export-section"');
    expect(html).not.toContain('[no especificado]');
  });

  // ── 20. E41 shows Vendedor / Proveedor, not Comprador ─────────

  it('E41 section heading is "Vendedor / Proveedor" not "Comprador"', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E41',
        buyerRnc: '987654321',
        buyerName: 'Proveedor ABC SRL',
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Vendedor / Proveedor');
    expect(html).not.toContain('<h3>Comprador</h3>');
  });

  // ── 21. E41 with explicit vendedor in metadata ────────────────

  it('E41 uses vendedor from metadata._originalDto.vendedor when present', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        ecfType: 'E41',
        buyerRnc: null,
        buyerName: null,
        metadata: {
          _originalDto: {
            vendedor: { rnc: '111222333', name: 'Proveedor Metadata SRL' },
          },
        },
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Proveedor Metadata SRL');
    expect(html).toContain('111222333');
  });

  // ── 22. ISC total row appears when totalIsc > 0 ───────────────

  it('shows ISC row in totals when totalIsc > 0', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ totalIsc: '500.00' }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('<span>ISC:</span>');
  });

  // ── 23. No ISC column when no line has ISC ────────────────────

  it('does NOT render ISC column header when no line has iscAmount > 0', async () => {
    prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
    const html = await service.generateHtml('t1', 'inv-001');
    // Column header should not exist
    expect(html).not.toContain('<th class="text-right">ISC</th>');
  });

  // ── 24. ISC column appears when at least one line has ISC ─────

  it('renders ISC column when at least one line has iscAmount > 0', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        lines: [
          { ...BASE_LINE, iscAmount: '200.00' },
          { ...BASE_LINE, lineNumber: 2, iscAmount: '0.00' },
        ],
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('<th class="text-right">ISC</th>');
  });

  // ── 25. Discount column shows amount when > 0 ────────────────

  it('shows discount amount in line row when discount > 0', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({
        lines: [{ ...BASE_LINE, discount: '100.00' }],
      }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    // Discount column is always rendered; value must contain the formatted amount
    expect(html).toContain('100');
    // The discount column header must be present
    expect(html).toContain('Descuento');
  });

  // ── 26. Payment date shown when set ──────────────────────────

  it('shows Fecha Pago when paymentDate is set', async () => {
    prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ paymentDate: new Date('2026-05-10T12:00:00Z') }),
    );
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).toContain('Fecha Pago');
    expect(html).toContain('10/05/2026');
  });

  // ── 27. Payment date NOT shown when null ──────────────────────

  it('does NOT show Fecha Pago when paymentDate is null', async () => {
    prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ paymentDate: null }));
    const html = await service.generateHtml('t1', 'inv-001');
    expect(html).not.toContain('Fecha Pago');
  });

  // ── 28. getFiscalLegend unit test ────────────────────────────

  it('getFiscalLegend returns empty string for unknown type', () => {
    expect(service.getFiscalLegend('E99')).toBe('');
  });
});
