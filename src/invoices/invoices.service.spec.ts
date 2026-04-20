/**
 * InvoicesService — async pipeline tests
 *
 * Validates the refactored POST /invoices flow:
 * - Only idempotency / company lookup / business validations / eNCF / XML
 *   build / XSD / INSERT (QUEUED) / audit / enqueue remain synchronous.
 * - Signing, DGII submission, and status polling are owned by the
 *   EcfProcessingProcessor and are not touched during create().
 *
 * Prisma, QueueService, and all DGII-adjacent dependencies are mocked so the
 * suite runs without a live database or Redis.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoiceStatus, WebhookEvent } from '@prisma/client';
import { makeTestLogger } from '../common/logger/test-logger';

type Mock = jest.Mock;

function makeValidDto(overrides: Partial<any> = {}) {
  return {
    companyId: 'company-uuid-1',
    ecfType: 'E31',
    buyer: {
      rnc: '101234567',
      name: 'Comprador Test SRL',
      type: 1,
      email: 'buyer@test.com',
    },
    items: [
      {
        description: 'Consultoría',
        quantity: 1,
        unitPrice: 1000,
        itbisRate: 18,
      },
    ],
    payment: { type: 1 },
    idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

function makeCompany() {
  return {
    id: 'company-uuid-1',
    tenantId: 'tenant-1',
    rnc: '131234567',
    businessName: 'Emisor SRL',
    tradeName: null,
    branchCode: null,
    address: 'Av. Principal',
    municipality: '010101',
    province: '010000',
    economicActivity: null,
    dgiiEnv: 'DEV',
    isActive: true,
  };
}

function makeMocks() {
  const prisma = {
    invoice: {
      findUnique: jest.fn() as Mock,
      findFirst: jest.fn() as Mock,
      create: jest.fn() as Mock,
      update: jest.fn() as Mock,
      findMany: jest.fn() as Mock,
      count: jest.fn() as Mock,
    },
    invoiceLine: {
      createMany: jest.fn() as Mock,
    },
    company: {
      findFirst: jest.fn() as Mock,
    },
    sequence: {
      findFirst: jest.fn() as Mock,
    },
    auditLog: {
      create: jest.fn() as Mock,
    },
  };

  const xmlBuilder = {
    buildEcfXml: jest.fn(() => ({
      xml: '<ECF><x/></ECF>',
      totals: {
        subtotalBeforeTax: 1000,
        totalDiscount: 0,
        totalItbis: 180,
        totalIsc: 0,
        totalAmount: 1180,
      },
    })) as Mock,
    buildRfceXml: jest.fn() as Mock,
  };

  const xsdValidation = {
    isAvailable: jest.fn(() => false) as Mock,
    validateXml: jest.fn() as Mock,
  };

  const sequencesService = {
    getNextEncf: jest.fn(async () => 'E310000000001') as Mock,
  };

  const rncValidation = {
    validateFormat: jest.fn(() => ({ valid: true })) as Mock,
  };

  const queueService = {
    enqueueEcfProcessing: jest.fn(async () => ({ id: 'job-1' })) as Mock,
  };

  const webhooksService = {
    emit: jest.fn(async () => ({ jobId: 'hook-1', deliveryId: 'del-1' })) as Mock,
  };

  // unused by create() but wired so DI works
  const signingService: any = {};
  const dgiiService: any = {};
  const certificatesService: any = {};
  const validationService: any = {};

  return {
    prisma,
    xmlBuilder,
    xsdValidation,
    sequencesService,
    rncValidation,
    queueService,
    webhooksService,
    signingService,
    dgiiService,
    certificatesService,
    validationService,
  };
}

function buildService(mocks: ReturnType<typeof makeMocks>) {
  return new InvoicesService(
    mocks.prisma as any,
    mocks.xmlBuilder as any,
    mocks.signingService,
    mocks.dgiiService,
    mocks.certificatesService,
    mocks.sequencesService as any,
    mocks.validationService,
    mocks.xsdValidation as any,
    mocks.rncValidation as any,
    mocks.queueService as any,
    mocks.webhooksService as any,
    makeTestLogger(),
  );
}

describe('InvoicesService.create — async pipeline', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: InvoicesService;

  beforeEach(() => {
    mocks = makeMocks();
    service = buildService(mocks);

    mocks.prisma.company.findFirst.mockResolvedValue(makeCompany());
    mocks.prisma.sequence.findFirst.mockResolvedValue({ expiresAt: new Date('2026-12-31') });
    mocks.prisma.invoice.create.mockImplementation(async ({ data }: any) => ({
      id: 'invoice-uuid-1',
      ...data,
    }));
    mocks.prisma.invoiceLine.createMany.mockResolvedValue({ count: 1 });
    mocks.prisma.auditLog.create.mockResolvedValue({});
    // findOne() at the end
    mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      tenantId: where.tenantId,
      encf: 'E310000000001',
      status: InvoiceStatus.QUEUED,
      ecfType: 'E31',
      lines: [],
      company: { rnc: '131234567', businessName: 'Emisor SRL' },
      isRfce: false,
    }));
  });

  it('persists invoice with status=QUEUED and enqueues exactly one job', async () => {
    const dto = makeValidDto();

    const result = await service.create('tenant-1', dto);

    // Prisma.create called with status QUEUED
    expect(mocks.prisma.invoice.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe(InvoiceStatus.QUEUED);
    expect(createArgs.data.xmlUnsigned).toContain('<ECF>');

    // Exactly one job enqueued
    expect(mocks.queueService.enqueueEcfProcessing).toHaveBeenCalledTimes(1);
    expect(mocks.queueService.enqueueEcfProcessing).toHaveBeenCalledWith({
      invoiceId: 'invoice-uuid-1',
      tenantId: 'tenant-1',
      companyId: 'company-uuid-1',
    });

    // Response contains the QUEUED status
    expect(result.status).toBe(InvoiceStatus.QUEUED);
    expect(result.encf).toBe('E310000000001');
  });

  it('records an audit log with action=queued (no "submitted" action)', async () => {
    await service.create('tenant-1', makeValidDto());

    expect(mocks.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = mocks.prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('queued');
    expect(auditArgs.data.entityType).toBe('invoice');
  });

  it('emits the INVOICE_QUEUED webhook after enqueuing the job', async () => {
    await service.create('tenant-1', makeValidDto());

    expect(mocks.webhooksService.emit).toHaveBeenCalledTimes(1);
    const [tenantId, event, payload] = mocks.webhooksService.emit.mock.calls[0];
    expect(tenantId).toBe('tenant-1');
    expect(event).toBe(WebhookEvent.INVOICE_QUEUED);
    expect(payload).toEqual(
      expect.objectContaining({
        invoiceId: 'invoice-uuid-1',
        encf: 'E310000000001',
        ecfType: 'E31',
      }),
    );
  });

  it('does not touch signing, certificates, or DGII in create()', async () => {
    // Fail the test if any of these are ever called
    mocks.signingService.signXml = jest.fn(() => {
      throw new Error('signXml must not run during create()');
    });
    mocks.signingService.extractFromP12 = jest.fn(() => {
      throw new Error('extractFromP12 must not run during create()');
    });
    mocks.dgiiService.getToken = jest.fn(() => {
      throw new Error('getToken must not run during create()');
    });
    mocks.dgiiService.submitEcf = jest.fn(() => {
      throw new Error('submitEcf must not run during create()');
    });
    mocks.certificatesService.getDecryptedCertificate = jest.fn(() => {
      throw new Error('getDecryptedCertificate must not run during create()');
    });

    await service.create('tenant-1', makeValidDto());
    // none of the mocks above threw — good
  });

  describe('idempotency', () => {
    it('returns the cached invoice without re-enqueuing when idempotencyKey hits', async () => {
      const existing = {
        id: 'existing-id',
        encf: 'E310000000099',
        status: InvoiceStatus.ACCEPTED,
        idempotencyKey: 'repeated-key',
      };
      mocks.prisma.invoice.findUnique.mockResolvedValueOnce(existing);

      const result = await service.create('tenant-1', makeValidDto({
        idempotencyKey: 'repeated-key',
      }));

      expect(result.id).toBe('existing-id');
      expect(mocks.prisma.invoice.create).not.toHaveBeenCalled();
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });
  });

  describe('business validation rejects before enqueue', () => {
    it('E33 without reference → BadRequest, no DB insert, no enqueue', async () => {
      const dto = makeValidDto({ ecfType: 'E33' });
      delete (dto as any).reference;

      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.prisma.invoice.create).not.toHaveBeenCalled();
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('E34 without reference → BadRequest, no enqueue', async () => {
      const dto = makeValidDto({ ecfType: 'E34' });
      delete (dto as any).reference;

      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('E31 without buyer RNC → BadRequest, no enqueue', async () => {
      const dto = makeValidDto({
        buyer: { name: 'No RNC', type: 1 },
      });
      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('credit payment without termDays → BadRequest, no enqueue', async () => {
      const dto = makeValidDto({
        payment: { type: 2 }, // missing termDays
      });
      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('discount > line subtotal → BadRequest, no enqueue', async () => {
      const dto = makeValidDto({
        items: [
          { description: 'X', quantity: 1, unitPrice: 100, discount: 200, itbisRate: 18 },
        ],
      });
      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('unknown company → NotFound, no enqueue', async () => {
      mocks.prisma.company.findFirst.mockResolvedValueOnce(null);
      await expect(service.create('tenant-1', makeValidDto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });
  });

  describe('E32 < 250K → isRfce flag in the persisted invoice', () => {
    it('sets isRfce=true when E32 total is under the threshold', async () => {
      mocks.xmlBuilder.buildEcfXml.mockReturnValueOnce({
        xml: '<ECF/>',
        totals: {
          subtotalBeforeTax: 1000,
          totalDiscount: 0,
          totalItbis: 180,
          totalIsc: 0,
          totalAmount: 1180, // < 250k
        },
      });
      await service.create('tenant-1', makeValidDto({
        ecfType: 'E32',
        buyer: { name: 'Consumidor', type: 2 },
      }));
      const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
      expect(createArgs.data.isRfce).toBe(true);
    });

    it('sets isRfce=false when E32 total >= threshold', async () => {
      mocks.xmlBuilder.buildEcfXml.mockReturnValueOnce({
        xml: '<ECF/>',
        totals: {
          subtotalBeforeTax: 260000,
          totalDiscount: 0,
          totalItbis: 46800,
          totalIsc: 0,
          totalAmount: 306800, // >= 250k
        },
      });
      await service.create('tenant-1', makeValidDto({
        ecfType: 'E32',
        buyer: { name: 'Consumidor', type: 2 },
      }));
      const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
      expect(createArgs.data.isRfce).toBe(false);
    });
  });
});
