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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  const prisma: any = {
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
    tenantPlan: {
      findFirst: jest.fn() as Mock,
    },
    monthlyUsage: {
      upsert: jest.fn() as Mock,
    },
    companyPlan: {
      findUnique: jest.fn() as Mock, // FIX 1: drives which billing meter is used
    },
  };
  // $transaction executes the callback with prisma itself acting as the tx client
  prisma.$transaction = jest.fn((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));

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
  };

  const sequencesService = {
    getNextEncf: jest.fn(async () => 'E310000000001') as Mock,
    // FIX 1 (C1): create() now consumes the eNCF inside the emission tx.
    getNextEncfInTx: jest.fn(async () => ({
      encf: 'E310000000001',
      expiresAt: new Date('2026-12-31'),
    })) as Mock,
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

  const billingService = {
    incrementInvoiceCount: jest.fn().mockResolvedValue(undefined) as Mock,
  };

  const usageService = {
    incrementUsage: jest.fn().mockResolvedValue(undefined) as Mock,
    notifyThresholds: jest.fn().mockResolvedValue(undefined) as Mock,
    revertUsage: jest.fn().mockResolvedValue(undefined) as Mock,
  };

  return {
    prisma,
    xmlBuilder,
    sequencesService,
    rncValidation,
    queueService,
    webhooksService,
    signingService,
    dgiiService,
    certificatesService,
    validationService,
    billingService,
    usageService,
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
    mocks.rncValidation as any,
    mocks.queueService as any,
    mocks.webhooksService as any,
    mocks.billingService as any,
    makeTestLogger(),
    mocks.usageService as any,
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
    mocks.prisma.tenantPlan.findFirst.mockResolvedValue(null); // billing check in tx
    mocks.prisma.monthlyUsage.upsert.mockResolvedValue({});
    // findFirst is used both for the per-tenant idempotency lookup (FIX 3) and
    // for findOne() at the end. The idempotency lookup must miss (return null) so
    // create() proceeds; the by-id lookup returns the created invoice.
    mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.idempotencyKey) return null;
      return ({
      id: where.id ?? 'invoice-uuid-1',
      tenantId: where.tenantId ?? 'tenant-1',
      encf: 'E310000000001',
      status: InvoiceStatus.QUEUED,
      ecfType: 'E31',
      lines: [],
      company: { rnc: '131234567', businessName: 'Emisor SRL' },
      isRfce: false,
      });
    });
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
      hasReference: false,
    });

    // Response contains the QUEUED status
    expect(result.status).toBe(InvoiceStatus.QUEUED);
    expect(result.encf).toBe('E310000000001');
  });

  // FIX 1 (isolation): exactly ONE billing meter per emission, chosen by whether
  // the company has its own CompanyPlan. A company-billed company must NOT also
  // increment the tenant-level legacy meter (which would share quota across the
  // owner's companies).
  it('FIX 1: company WITH a CompanyPlan counts company usage only (NOT the tenant meter)', async () => {
    mocks.prisma.companyPlan.findUnique.mockResolvedValueOnce({ companyId: 'company-uuid-1' });

    await service.create('tenant-1', makeValidDto());

    expect(mocks.usageService.incrementUsage).toHaveBeenCalledWith('company-uuid-1', expect.anything());
    expect(mocks.billingService.incrementInvoiceCount).not.toHaveBeenCalled();
  });

  it('FIX 1: company WITHOUT a CompanyPlan falls back to the tenant meter only', async () => {
    mocks.prisma.companyPlan.findUnique.mockResolvedValueOnce(null);

    await service.create('tenant-1', makeValidDto());

    expect(mocks.billingService.incrementInvoiceCount).toHaveBeenCalledWith('tenant-1', expect.anything());
    expect(mocks.usageService.incrementUsage).not.toHaveBeenCalled();
  });

  it('records an audit log with action=queued (no "submitted" action)', async () => {
    await service.create('tenant-1', makeValidDto());

    expect(mocks.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = mocks.prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('queued');
    expect(auditArgs.data.entityType).toBe('invoice');
  });

  it('AUDIT: records the real actor (apiKeyId) and ipAddress, not the hardcoded "api"', async () => {
    await service.create('tenant-1', makeValidDto(), { actor: 'apikey-abc', ipAddress: '200.10.20.30' });

    const auditArgs = mocks.prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.actor).toBe('apikey-abc');
    expect(auditArgs.data.ipAddress).toBe('200.10.20.30');
  });

  it('AUDIT: falls back to actor "api" / null ip when no actor context is provided', async () => {
    await service.create('tenant-1', makeValidDto());

    const auditArgs = mocks.prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.actor).toBe('api');
    expect(auditArgs.data.ipAddress).toBeNull();
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
      // FIX 3: idempotency lookup is now findFirst({ idempotencyKey, tenantId }).
      mocks.prisma.invoice.findFirst.mockResolvedValueOnce(existing);

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

  describe('metadata._originalDto no filtra encfOverride', () => {
    it('sin override → metadata._certification ausente, _originalDto sin encfOverride', async () => {
      await service.create('tenant-1', makeValidDto());

      const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
      const meta = createArgs.data.metadata;
      expect(meta._originalDto).not.toHaveProperty('encfOverride');
      expect(meta._certification).toBeUndefined();
    });

    it('con override → _certification presente, _originalDto sin encfOverride', async () => {
      mocks.prisma.company.findFirst.mockResolvedValueOnce({
        ...makeCompany(),
        dgiiEnv: 'CERT',
      });
      mocks.sequencesService.getNextEncfInTx.mockResolvedValueOnce({ encf: 'E320000000015', expiresAt: null });
      mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.idempotencyKey) return null; // FIX 3: idempotency lookup misses
        return {
          id: 'invoice-uuid-1',
          tenantId: 'tenant-1',
          encf: 'E320000000015',
          status: 'QUEUED',
          ecfType: 'E32',
          lines: [],
          company: { rnc: '131234567', businessName: 'Emisor SRL' },
          isRfce: false,
        };
      });

      await service.create('tenant-1', makeValidDto({
        ecfType: 'E32',
        buyer: { name: 'Consumidor', type: 2 },
        encfOverride: 15,
      }));

      const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
      const meta = createArgs.data.metadata;
      expect(meta._originalDto).not.toHaveProperty('encfOverride');
      expect(meta._certification).toMatchObject({
        forcedEncf: true,
        forcedNumber: 15,
        forcedAt: expect.any(String),
      });
    });
  });

  describe('encfOverride', () => {
    it('7. encfOverride en company dgiiEnv=PROD → ForbiddenException, sin enqueue', async () => {
      mocks.prisma.company.findFirst.mockResolvedValueOnce({
        ...makeCompany(),
        dgiiEnv: 'PROD',
      });

      const dto = makeValidDto({ encfOverride: 5 });
      await expect(service.create('tenant-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });

    it('8. encfOverride en company dgiiEnv=CERT → pasa override a getNextEncf y retorna ENCF correcto', async () => {
      mocks.prisma.company.findFirst.mockResolvedValueOnce({
        ...makeCompany(),
        dgiiEnv: 'CERT',
      });
      mocks.sequencesService.getNextEncfInTx.mockResolvedValueOnce({ encf: 'E320000000015', expiresAt: null });
      mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.idempotencyKey) return null; // FIX 3: idempotency lookup misses
        return {
          id: 'invoice-uuid-1',
          tenantId: 'tenant-1',
          encf: 'E320000000015',
          status: 'QUEUED',
          ecfType: 'E32',
          lines: [],
          company: { rnc: '131234567', businessName: 'Emisor SRL' },
          isRfce: false,
        };
      });

      const dto = makeValidDto({
        ecfType: 'E32',
        buyer: { name: 'Consumidor Final', type: 2 },
        encfOverride: 15,
      });
      const result = await service.create('tenant-1', dto);

      // FIX 1: eNCF is now consumed via getNextEncfInTx, threaded with the tx.
      expect(mocks.sequencesService.getNextEncfInTx).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'company-uuid-1',
        'E32',
        15,
      );
      expect(result.encf).toBe('E320000000015');
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

  // ─────────────────────────────────────────────────────────────
  // FIX 1 — referenceDate: parseDgiiDate instead of new Date()
  // Bug: new Date("DD-MM-YYYY") returns Invalid Date in Node/V8,
  // causing Prisma to throw when creating E33/E34 invoices.
  // ─────────────────────────────────────────────────────────────
  describe('FIX 1 — referenceDate parses DD-MM-YYYY correctly', () => {
    const refDateStr = '25-01-2024';

    function makeE33Dto() {
      return makeValidDto({
        ecfType: 'E33',
        buyer: { name: 'Deudor SRL', type: 1 },
        reference: {
          encf: 'E310000000001',
          date: refDateStr,
          modificationCode: 3,
        },
      });
    }

    it('E33 with reference.date="DD-MM-YYYY" creates invoice without throwing', async () => {
      // Setup: make findFirst return a valid E33 invoice after creation.
      // Must still MISS the per-tenant idempotency lookup (FIX 3) so create runs.
      mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.idempotencyKey) return null;
        return {
          id: 'invoice-e33-1',
          tenantId: 'tenant-1',
          encf: 'E330000000001',
          status: InvoiceStatus.QUEUED,
          ecfType: 'E33',
          lines: [],
          company: { rnc: '131234567', businessName: 'Emisor SRL' },
          isRfce: false,
          referenceDate: new Date(2024, 0, 25),
        };
      });

      await expect(service.create('tenant-1', makeE33Dto())).resolves.not.toThrow();
      expect(mocks.prisma.invoice.create).toHaveBeenCalledTimes(1);
    });

    it('referenceDate stored as valid Date (Jan 25, not Invalid Date)', async () => {
      await service.create('tenant-1', makeE33Dto());

      const createArgs = mocks.prisma.invoice.create.mock.calls[0][0];
      const storedDate: Date = createArgs.data.referenceDate;

      // Must be a real Date, not Invalid Date
      expect(storedDate).toBeInstanceOf(Date);
      expect(isNaN(storedDate.getTime())).toBe(false);

      // Must parse as January 25, 2024 (DD=25, MM=01, YYYY=2024)
      expect(storedDate.getFullYear()).toBe(2024);
      expect(storedDate.getMonth()).toBe(0);   // January = 0
      expect(storedDate.getDate()).toBe(25);
    });

    it('new Date("25-01-2024") would have produced Invalid Date (confirms the bug existed)', () => {
      // Regression guard: proves why the fix was necessary
      const buggyDate = new Date('25-01-2024');
      expect(isNaN(buggyDate.getTime())).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // FIX 1 (C1) — secuencial ↔ factura son ATÓMICOS
  // El eNCF se consume DENTRO de la misma transacción que inserta la
  // factura. Si un paso posterior falla, la transacción entera revierte,
  // por lo que el secuencial NUNCA queda consumido sin fila invoice.
  // ─────────────────────────────────────────────────────────────
  describe('FIX 1 — atomicidad secuencial↔factura', () => {
    // A $transaction mock that actually propagates rejections and flags rollback.
    function withRollbackAwareTx() {
      let rolledBack = false;
      mocks.prisma.$transaction.mockImplementation(async (fn: any) => {
        try {
          return await fn(mocks.prisma);
        } catch (e) {
          rolledBack = true;
          throw e;
        }
      });
      return () => rolledBack;
    }

    it('consume el secuencial DENTRO de la misma tx que el INSERT (mismo tx client)', async () => {
      await service.create('tenant-1', makeValidDto());

      // getNextEncfInTx recibió el MISMO tx client que usa invoice.create
      // (en el mock, prisma actúa como tx). Prueba estructural de atomicidad.
      const txArg = mocks.sequencesService.getNextEncfInTx.mock.calls[0][0];
      expect(txArg).toBe(mocks.prisma);
      // El getNextEncf legacy (fuera de tx) NO debe usarse en create().
      expect(mocks.sequencesService.getNextEncf).not.toHaveBeenCalled();
    });

    it('fallo post-consumo (INSERT falla) → tx revierte y NO hay enqueue ni webhook', async () => {
      const rolledBack = withRollbackAwareTx();
      mocks.prisma.invoice.create.mockRejectedValueOnce(new Error('DB constraint'));

      await expect(service.create('tenant-1', makeValidDto())).rejects.toThrow('DB constraint');

      // el secuencial se consumió dentro de la tx que lanzó → rollback
      expect(mocks.sequencesService.getNextEncfInTx).toHaveBeenCalledTimes(1);
      expect(rolledBack()).toBe(true);
      // ningún efecto post-commit se filtró
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
      expect(mocks.webhooksService.emit).not.toHaveBeenCalled();
    });

    it('cuota agotada (incrementUsage lanza) → tx revierte, sin enqueue ni webhook', async () => {
      const rolledBack = withRollbackAwareTx();
      mocks.prisma.companyPlan.findUnique.mockResolvedValueOnce({ companyId: 'company-uuid-1' });
      mocks.usageService.incrementUsage.mockRejectedValueOnce(
        new ForbiddenException('Cuota de comprobantes agotada'),
      );

      await expect(service.create('tenant-1', makeValidDto())).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(mocks.sequencesService.getNextEncfInTx).toHaveBeenCalledTimes(1);
      expect(rolledBack()).toBe(true);
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
      expect(mocks.webhooksService.emit).not.toHaveBeenCalled();
    });

    it('carrera de idempotencia: si la tx encuentra la factura ya creada, NO consume otro secuencial', async () => {
      // El pre-check externo falla (null), pero la RE-verificación dentro de la
      // tx encuentra la factura creada por una petición concurrente.
      const concurrent = {
        id: 'concurrent-id',
        encf: 'E310000000042',
        status: InvoiceStatus.QUEUED,
        idempotencyKey: 'race-key',
      };
      let call = 0;
      mocks.prisma.invoice.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.idempotencyKey) {
          call += 1;
          // 1ª llamada (pre-tx): miss. 2ª llamada (in-tx re-check): hit.
          return call === 1 ? null : concurrent;
        }
        return { id: where.id, tenantId: 'tenant-1', encf: 'E310000000042', status: 'QUEUED', ecfType: 'E31', lines: [], company: {}, isRfce: false };
      });

      await service.create('tenant-1', makeValidDto({ idempotencyKey: 'race-key' }));

      // No se consumió secuencial, no se insertó, no se encoló.
      expect(mocks.sequencesService.getNextEncfInTx).not.toHaveBeenCalled();
      expect(mocks.prisma.invoice.create).not.toHaveBeenCalled();
      expect(mocks.queueService.enqueueEcfProcessing).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // FIX 4 — la reemisión corregida toma un secuencial NUEVO
  // ─────────────────────────────────────────────────────────────
  describe('FIX 4 — reemisión usa un eNCF nuevo (nunca reutiliza el rechazado)', () => {
    it('dos emisiones consecutivas consumen dos eNCF distintos', async () => {
      mocks.sequencesService.getNextEncfInTx
        .mockResolvedValueOnce({ encf: 'E310000000009', expiresAt: null })
        .mockResolvedValueOnce({ encf: 'E310000000010', expiresAt: null });

      await service.create('tenant-1', makeValidDto());
      await service.create('tenant-1', makeValidDto());

      const encfs = mocks.prisma.invoice.create.mock.calls.map((c: any) => c[0].data.encf);
      expect(encfs).toEqual(['E310000000009', 'E310000000010']);
      // nunca se sobreescribe/reusa: cada create trae un eNCF distinto
      expect(new Set(encfs).size).toBe(2);
    });
  });
});
