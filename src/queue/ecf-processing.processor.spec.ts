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
import { makeTestLogger } from '../common/logger/test-logger';

// Fix 4j: convertECF32ToRFCE is imported directly (not injected). Mock it
// at the module level so RFCE tests don't need a real signed e-CF input.
jest.mock('dgii-ecf', () => ({
  ...jest.requireActual('dgii-ecf'),
  convertECF32ToRFCE: jest.fn(() => ({
    xml: '<RFCE><Encabezado><Version>1.0</Version></Encabezado></RFCE>',
    securityCode: 'ABC123',
  })),
}));

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

  const xsdValidation = {
    isAvailable: jest.fn(() => true) as Mock,
    validateXml: jest.fn(async () => ({
      valid: true,
      errors: [],
      warnings: [],
      schema: 'e-CF-31.xsd',
      durationMs: 5,
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
    xsdValidation as any,
    queueService as any,
    webhooksService as any,
    makeTestLogger(),
  );

  return {
    processor,
    prisma,
    xmlBuilder,
    signingService,
    dgiiService,
    certificatesService,
    xsdValidation,
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

  describe('XSD validation post-sign', () => {
    it('proceeds to DGII when XSD validation passes', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-XSD-OK', message: 'Aceptado',
      });
      // default mock returns valid: true

      const result = await m.processor.process(makeJob());

      expect(m.xsdValidation.isAvailable).toHaveBeenCalled();
      expect(m.xsdValidation.validateXml).toHaveBeenCalledWith(
        '<ECF><Signature/></ECF>',
        31, // E31 → typeCode 31
      );
      expect(result.status).toBe(InvoiceStatus.ACCEPTED);
      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
    });

    it('marks ERROR and fires INVOICE_ERROR when XSD validation fails post-sign', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.xsdValidation.validateXml.mockResolvedValue({
        valid: false,
        errors: ["Element 'ECF': Missing child element(s). Expected is ( FechaHoraFirma )"],
        warnings: [],
        schema: 'e-CF-31.xsd',
        durationMs: 8,
      });

      const result = await m.processor.process(makeJob());

      expect(result.status).toBe(InvoiceStatus.ERROR);

      // xmlSigned is saved before validation — should persist for audit
      const firstUpdate = m.prisma.invoice.update.mock.calls[0][0].data;
      expect(firstUpdate.xmlSigned).toBe('<ECF><Signature/></ECF>');
      expect(firstUpdate.status).toBe(InvoiceStatus.PROCESSING);

      // Second update marks ERROR
      const secondUpdate = m.prisma.invoice.update.mock.calls[1][0].data;
      expect(secondUpdate.status).toBe(InvoiceStatus.ERROR);
      expect(secondUpdate.dgiiMessage).toMatch(/XSD validation failed/);

      // DGII is never called
      expect(m.dgiiService.getToken).not.toHaveBeenCalled();
      expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();

      // INVOICE_ERROR webhook fired
      const events = m.webhooksService.emit.mock.calls.map((c) => c[1]);
      expect(events).toContain(WebhookEvent.INVOICE_ERROR);
    });

    it('skips XSD validation and proceeds to DGII when xmllint is unavailable', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice());
      m.xsdValidation.isAvailable.mockReturnValue(false);
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-NO-XSD', message: 'Aceptado',
      });

      const result = await m.processor.process(makeJob());

      expect(m.xsdValidation.validateXml).not.toHaveBeenCalled();
      expect(result.status).toBe(InvoiceStatus.ACCEPTED);
      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
    });

    it('validates E33 (nota de débito) signed XML with typeCode 33', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ ecfType: 'E33', encf: 'E330000000001' }));
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-E33', message: 'Aceptado',
      });

      await m.processor.process(makeJob());

      expect(m.xsdValidation.validateXml).toHaveBeenCalledWith(
        expect.any(String),
        33, // E33 → typeCode 33
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // FIX 2 — isRfce reads invoice.isRfce, not Number(totalAmount)
  // Bug: Number(Decimal) can drift due to floating-point coercion,
  // causing the wrong submission path for E32 near the 250K threshold.
  // ─────────────────────────────────────────────────────────────
  describe('FIX 2 — isRfce uses invoice.isRfce flag, not Number(totalAmount)', () => {
    it('routes E32 with isRfce=true to submitRfce, never submitEcf', async () => {
      const m = makeProcessor();
      // isRfce=true (stored at creation), totalAmount is a Decimal-like object
      // that Number() might coerce to 250000 even though it was < threshold
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({
        ecfType: 'E32',
        encf: 'E320000000001',
        isRfce: true,
        totalAmount: { toNumber: () => 249999.99, toString: () => '249999.99' },
        metadata: { _originalDto: {
          ecfType: 'E32',
          buyer: { name: 'Consumidor', type: 2 },
          items: [{ description: 'X', quantity: 1, unitPrice: 249999.99, itbisRate: 0 }],
          payment: { type: 1 },
        }},
      }));
      m.xmlBuilder.buildEcfXml.mockReturnValue({
        xml: '<ECF/>',
        totals: { subtotalBeforeTax: 249999.99, totalDiscount: 0, totalItbis: 0, totalIsc: 0, totalAmount: 249999.99 },
      });
      // Fix 4j: no longer mocking buildRfceXml — convertECF32ToRFCE is
      // mocked at module level (top of file) so it returns a fixed RFCE.
      m.dgiiService.submitRfce.mockResolvedValue({
        status: 1, trackId: null, message: 'RFCE aceptado',
      });

      await m.processor.process(makeJob());

      expect(m.dgiiService.submitRfce).toHaveBeenCalledTimes(1);
      expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
      // The signing service should sign TWICE: once for the e-CF, once for the RFCE.
      expect(m.signingService.signXml).toHaveBeenCalledTimes(2);
    });

    it('routes E32 with isRfce=false to submitEcf, never submitRfce', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({
        ecfType: 'E32',
        encf: 'E320000000002',
        isRfce: false,
        totalAmount: 306800,
      }));
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-E32-STD', message: 'Aceptado',
      });

      await m.processor.process(makeJob());

      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
      expect(m.dgiiService.submitRfce).not.toHaveBeenCalled();
    });

    // Fix 4j: convertECF32ToRFCE called with the SIGNED e-CF, not the unsigned one.
    it('Fix 4j: convertECF32ToRFCE is called with the signed e-CF (signedXml)', async () => {
      const { convertECF32ToRFCE } = jest.requireMock('dgii-ecf');
      convertECF32ToRFCE.mockClear();

      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({
        ecfType: 'E32',
        encf: 'E320000000099',
        isRfce: true,
        totalAmount: { toNumber: () => 40120, toString: () => '40120.00' },
        metadata: { _originalDto: {} },
      }));
      m.signingService.signXml.mockReturnValueOnce({
        signedXml: '<ECF><Signature>SIGNED-ECF-FORM</Signature></ECF>',
        securityCode: 'ABC123',
        signTime: new Date('2026-04-19T12:00:00Z'),
        signatureValue: 'sigval',
      }).mockReturnValueOnce({
        signedXml: '<RFCE><Signature>SIGNED-RFCE</Signature></RFCE>',
        securityCode: 'ABC123',
        signTime: new Date('2026-04-19T12:00:00Z'),
        signatureValue: 'sigval',
      });
      m.dgiiService.submitRfce.mockResolvedValue({
        status: 1, trackId: null, message: 'RFCE aceptado',
      });

      await m.processor.process(makeJob());

      // convertECF32ToRFCE should receive the FIRST signedXml (the e-CF), not
      // the original unsigned XML, because we need the SignatureValue inside
      // it to extract the first 6 chars as CodigoSeguridadeCF.
      expect(convertECF32ToRFCE).toHaveBeenCalledWith('<ECF><Signature>SIGNED-ECF-FORM</Signature></ECF>');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Fix 4n — referenceEncf ordering: invoices that modify another e-CF
  // must wait until the referenced e-CF is ACCEPTED in DGII.
  // ─────────────────────────────────────────────────────────────
  describe('Fix 4n — referenceEncf ordering check', () => {
    it('throws (triggers retry) when referenced invoice is not yet ACCEPTED', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst
        .mockResolvedValueOnce(makeInvoice({
          ecfType: 'E33',
          encf: 'E330000000001',
          referenceEncf: 'E320000000006',
        }))
        // Second findFirst call: looking up the referenced invoice
        .mockResolvedValueOnce({
          id: 'ref-id', status: InvoiceStatus.PROCESSING, encf: 'E320000000006',
        });

      await expect(m.processor.process(makeJob())).rejects.toThrow(/waiting for referenced/);
      expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
      expect(m.signingService.signXml).not.toHaveBeenCalled();
    });

    it('proceeds normally when referenced invoice is ACCEPTED', async () => {
      const m = makeProcessor();
      m.prisma.invoice.findFirst
        .mockResolvedValueOnce(makeInvoice({
          ecfType: 'E33',
          encf: 'E330000000001',
          referenceEncf: 'E320000000006',
        }))
        .mockResolvedValueOnce({
          id: 'ref-id', status: InvoiceStatus.ACCEPTED, encf: 'E320000000006',
        });
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-OK', message: 'Aceptado',
      });

      await m.processor.process(makeJob());

      expect(m.signingService.signXml).toHaveBeenCalled();
      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
    });

    it('Fix 4p: throws to retry when the referenced invoice is not yet in our DB', async () => {
      // The previous Fix 4n behavior was "proceed" when the reference was
      // absent — assuming it was an external e-CF. But for bulk uploads
      // (certification Excel) all 25 invoices are inserted within a few
      // hundred milliseconds, so when E33:1's processor job runs, E32:6
      // may not yet exist in the DB. Proceeding sent the modifier to DGII
      // before its parent and got rejected with code 614. Fix 4p throws
      // in this case too; by retry #2 or #3 the referenced invoice has
      // been inserted by the upload's parallel transactions.
      const m = makeProcessor();
      m.prisma.invoice.findFirst
        .mockResolvedValueOnce(makeInvoice({
          ecfType: 'E33',
          encf: 'E330000000001',
          referenceEncf: 'E990000000001',
        }))
        .mockResolvedValueOnce(null);

      await expect(m.processor.process(makeJob())).rejects.toThrow(/not yet in DB/);
      expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
      expect(m.signingService.signXml).not.toHaveBeenCalled();
    });

    it('does NOT check reference for invoices without referenceEncf', async () => {
      // Standard e-CF flow: no extra DB query, no reordering.
      const m = makeProcessor();
      m.prisma.invoice.findFirst.mockResolvedValueOnce(makeInvoice({
        ecfType: 'E31',
        encf: 'E310000000001',
        // No referenceEncf
      }));
      m.dgiiService.submitEcf.mockResolvedValue({
        status: 1, trackId: 'TRACK-OK', message: 'Aceptado',
      });

      await m.processor.process(makeJob());

      // Only one findFirst (loading the invoice itself), no second lookup
      expect(m.prisma.invoice.findFirst).toHaveBeenCalledTimes(1);
      expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
    });
  });
});
