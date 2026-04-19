/**
 * EcfProcessingProcessor — async pipeline tests
 *
 * Validates the async worker behavior:
 * - Happy path: sign + submit + update status + fire webhooks (accepted / submitted)
 * - DGII returns PROCESSING → enqueue status poll
 * - DGII 5xx/network → rethrow for BullMQ retry, status CONTINGENCY
 * - Non-network exception (cert issue) → status ERROR, fire webhook, no retry
 * - onFailed event fires INVOICE_CONTINGENCY only when retries exhausted
 */
import { EcfProcessingProcessor } from './ecf-processing.processor';
import { InvoiceStatus, WebhookEvent } from '@prisma/client';

type Mock = jest.Mock;

function makeInvoice(overrides: Partial<any> = {}) {
  return {
    id: 'invoice-1',
    tenantId: 'tenant-1',
    companyId: 'company-1',
    encf: 'E310000000001',
    ecfType: 'E31',
    status: InvoiceStatus.QUEUED,
    xmlUnsigned: '<ECF/>',
    totalAmount: 1180,
    company: {
      rnc: '131234567',
      businessName: 'Emisor SRL',
      tradeName: null,
      branchCode: null,
      address: null,
      municipality: null,
      province: null,
      economicActivity: null,
      dgiiEnv: 'DEV',
    },
    ...overrides,
  };
}

function makeProcessor() {
  const prisma = {
    invoice: {
      findFirst: jest.fn() as Mock,
      update: jest.fn(async () => ({})) as Mock,
    },
  };

  const xmlBuilder = {
    buildEcfXml: jest.fn() as Mock,
    buildRfceXml: jest.fn() as Mock,
  };

  const signingService = {
    extractFromP12: jest.fn(() => ({ privateKey: 'PK', certificate: 'CERT' })) as Mock,
    signXml: jest.fn(() => ({
      signedXml: '<ECF><Signature/></ECF>',
      securityCode: 'ABC123',
      signTime: new Date('2026-04-19T12:00:00Z'),
      signatureValue: 'sigval',
    })) as Mock,
  };

  const dgiiService = {
    getToken: jest.fn(async () => 'fake-token') as Mock,
    submitEcf: jest.fn() as Mock,
    submitRfce: jest.fn() as Mock,
  };

  const certificatesService = {
    getDecryptedCertificate: jest.fn(async () => ({
      p12Buffer: Buffer.from('p12'),
      passphrase: 'pw',
    })) as Mock,
  };

  const queueService = {
    enqueueStatusPoll: jest.fn(async () => ({ id: 'poll-1' })) as Mock,
  };

  const webhooksService = {
    emit: jest.fn(async () => ({ jobId: 'hook-1', deliveryId: 'del-1' })) as Mock,
  };

  const processor = new EcfProcessingProcessor(
    prisma as any,
    xmlBuilder as any,
    signingService as any,
    dgiiService as any,
    certificatesService as any,
    queueService as any,
    webhooksService as any,
  );

  return {
    processor,
    prisma,
    xmlBuilder,
    signingService,
    dgiiService,
    certificatesService,
    queueService,
    webhooksService,
  };
}

function makeJob(overrides: Partial<any> = {}): any {
  return {
    id: 'job-1',
    data: { invoiceId: 'invoice-1', tenantId: 'tenant-1', companyId: 'company-1' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    ...overrides,
  };
}

describe('EcfProcessingProcessor', () => {
  describe('happy path', () => {
    it('signs, submits, updates ACCEPTED, fires INVOICE_SUBMITTED and INVOICE_ACCEPTED', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, // ACCEPTED
        trackId: 'TRACK-123',
        message: 'Aceptado',
      });

      const result = await m.processor.process(makeJob());

      expect(result.status).toBe(InvoiceStatus.ACCEPTED);
      expect(result.trackId).toBe('TRACK-123');

      // Signed and submitted once each
      expect(m.signingService.signXml).toHaveBeenCalledTimes(1);
      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);

      // Webhook fan-out: submitted (has trackId) + accepted
      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).toContain(WebhookEvent.INVOICE_SUBMITTED);
      expect(events).toContain(WebhookEvent.INVOICE_ACCEPTED);

      // Status polling NOT scheduled when DGII returns final status
      expect(m.queueService.enqueueStatusPoll).not.toHaveBeenCalled();
    });
  });

  describe('DGII returns PROCESSING', () => {
    it('schedules a status poll and fires INVOICE_SUBMITTED', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 3, // PROCESSING
        trackId: 'TRACK-456',
        message: 'En Proceso',
      });

      await m.processor.process(makeJob());

      expect(m.queueService.enqueueStatusPoll).toHaveBeenCalledTimes(1);
      expect(m.queueService.enqueueStatusPoll).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: 'invoice-1',
          tenantId: 'tenant-1',
          companyId: 'company-1',
          attempt: 1,
        }),
      );

      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).toContain(WebhookEvent.INVOICE_SUBMITTED);
      // No final-state webhook while still PROCESSING
      expect(events).not.toContain(WebhookEvent.INVOICE_ACCEPTED);
      expect(events).not.toContain(WebhookEvent.INVOICE_REJECTED);
    });
  });

  describe('network error (DGII 5xx / timeout)', () => {
    it('marks invoice CONTINGENCY and rethrows for BullMQ retry', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.dgiiService.submitEcf.mockRejectedValue(
        Object.assign(new Error('ECONNREFUSED to DGII'), { status: 503 }),
      );

      await expect(m.processor.process(makeJob())).rejects.toThrow();

      // Final update call targeted status=CONTINGENCY
      const statusUpdates = m.prisma.invoice.update.mock.calls
        .map((c) => c[0].data.status)
        .filter((s) => !!s);
      expect(statusUpdates).toContain(InvoiceStatus.CONTINGENCY);

      // No INVOICE_ERROR webhook (that's only for non-network errors)
      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).not.toContain(WebhookEvent.INVOICE_ERROR);
    });
  });

  describe('non-network error (cert extraction fails)', () => {
    it('marks invoice ERROR, fires INVOICE_ERROR, and does NOT rethrow', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.signingService.extractFromP12.mockImplementation(() => {
        throw new Error('Certificado inválido: wrong passphrase');
      });

      const result = await m.processor.process(makeJob());

      expect(result.status).toBe(InvoiceStatus.ERROR);

      const statusUpdates = m.prisma.invoice.update.mock.calls
        .map((c) => c[0].data.status)
        .filter((s) => !!s);
      expect(statusUpdates).toContain(InvoiceStatus.ERROR);

      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).toContain(WebhookEvent.INVOICE_ERROR);
    });
  });

  describe('onFailed worker event — INVOICE_CONTINGENCY emission', () => {
    it('fires INVOICE_CONTINGENCY only when BullMQ has exhausted retries', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue({
        encf: 'E310000000001',
        status: InvoiceStatus.CONTINGENCY,
      });

      // Simulate final failure: attemptsMade == opts.attempts
      await (m.processor as any).onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('DGII 503'),
      );

      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).toContain(WebhookEvent.INVOICE_CONTINGENCY);
    });

    it('does NOT fire INVOICE_CONTINGENCY on intermediate retries', async () => {
      const m = makeProcessor();

      // Intermediate failure: still have retries left
      await (m.processor as any).onFailed(
        makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
        new Error('DGII 503'),
      );

      expect(m.webhooksService.emit).not.toHaveBeenCalled();
      // Should not even need to look at the invoice yet
      expect(m.prisma.invoice.findFirst).not.toHaveBeenCalled();
    });

    it('does NOT fire INVOICE_CONTINGENCY if the invoice landed in a non-contingency state', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue({
        encf: 'E310000000001',
        status: InvoiceStatus.ACCEPTED, // somehow recovered
      });

      await (m.processor as any).onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('DGII 503'),
      );

      expect(m.webhooksService.emit).not.toHaveBeenCalled();
    });
  });

  describe('already-final invoice', () => {
    it('skips processing when invoice status is ACCEPTED', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(
        makeInvoice({ status: InvoiceStatus.ACCEPTED }),
      );

      const result = await m.processor.process(makeJob());

      expect(result.status).toBe(InvoiceStatus.ACCEPTED);
      expect(m.signingService.signXml).not.toHaveBeenCalled();
      expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
      expect(m.webhooksService.emit).not.toHaveBeenCalled();
    });
  });
});
