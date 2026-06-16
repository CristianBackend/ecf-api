/**
 * StatusPollProcessor — unit tests
 *
 * Covers:
 * FIX 5 — timeout (MAX_ATTEMPTS exceeded) marks invoice as ERROR
 * FIX 6 — no trackId after failed reconciliation marks invoice as ERROR
 */
import { StatusPollProcessor } from './status-poll.processor';
import { InvoiceStatus } from '@prisma/client';
import { makeTestLogger } from '../common/logger/test-logger';
import { DelayedError } from 'bullmq';

type Mock = jest.Mock;

function makeInvoice(overrides: Partial<any> = {}) {
  return {
    id: 'invoice-1',
    tenantId: 'tenant-1',
    companyId: 'company-1',
    encf: 'E310000000001',
    ecfType: 'E31',
    status: InvoiceStatus.PROCESSING,
    trackId: 'TRACK-001',
    isRfce: false,
    company: {
      rnc: '131234567',
      businessName: 'Emisor SRL',
      dgiiEnv: 'CERT',
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

  const dgiiService = {
    getToken: jest.fn(async () => 'token-abc') as Mock,
    queryStatus: jest.fn() as Mock,
    queryTrackIds: jest.fn() as Mock,
  };

  const signingService = {
    extractFromP12: jest.fn(() => ({ privateKey: 'PK', certificate: 'CERT' })) as Mock,
  };

  const certificatesService = {
    getDecryptedCertificate: jest.fn(async () => ({
      p12Buffer: Buffer.from('p12'),
      passphrase: 'pw',
    })) as Mock,
  };

  const queueService = {
    enqueueStatusPoll: jest.fn(async () => ({})) as Mock,
  };

  const webhooksService = {
    emit: jest.fn(async () => ({})) as Mock,
  };

  const usageService = {
    revertUsage: jest.fn(async () => {}) as Mock,
  };

  const processor = new StatusPollProcessor(
    prisma as any,
    dgiiService as any,
    signingService as any,
    certificatesService as any,
    queueService as any,
    webhooksService as any,
    usageService as any,
    makeTestLogger(),
  );

  return { processor, prisma, dgiiService, signingService, certificatesService, queueService, webhooksService, usageService };
}

function makeJob(overrides: Partial<any> = {}): any {
  return {
    id: 'job-1',
    data: {
      invoiceId: 'invoice-1',
      tenantId: 'tenant-1',
      companyId: 'company-1',
      attempt: 1,
    },
    token: 'token',
    opts: { attempts: 3 },
    moveToDelayed: jest.fn(async () => {}),
    updateData: jest.fn(async () => {}),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// FIX 5 — TIMEOUT marks invoice as ERROR
// ─────────────────────────────────────────────────────────────
describe('FIX 5 — polling TIMEOUT marks invoice as ERROR', () => {
  it('marks invoice ERROR when attempt exceeds MAX_ATTEMPTS (20)', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ trackId: 'TRACK-001' }));

    const job = makeJob({ data: { invoiceId: 'invoice-1', tenantId: 'tenant-1', companyId: 'company-1', attempt: 21 } });

    const result = await m.processor.process(job);

    expect(result.status).toBe('TIMEOUT');

    // FIX 5 — must update to ERROR, not just dgiiMessage
    expect(m.prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InvoiceStatus.ERROR,
          dgiiMessage: expect.stringContaining('timed out'),
        }),
      }),
    );
  });

  it('does NOT mark ERROR when attempt is exactly at MAX_ATTEMPTS (still polls)', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ trackId: 'TRACK-001' }));
    m.dgiiService.queryStatus.mockResolvedValue({ status: 3, message: 'En Proceso', rawResponse: '' });

    const job = makeJob({ data: { invoiceId: 'invoice-1', tenantId: 'tenant-1', companyId: 'company-1', attempt: 20 } });
    job.moveToDelayed.mockResolvedValue(undefined);
    job.updateData.mockResolvedValue(undefined);

    // attempt=20 <= MAX_ATTEMPTS=20 → should NOT timeout, should reschedule
    await expect(m.processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    // Should not have updated to TIMEOUT ERROR
    const errorUpdates = m.prisma.invoice.update.mock.calls.filter(
      (c: any[]) => c[0].data?.status === InvoiceStatus.ERROR,
    );
    expect(errorUpdates.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// FIX 6 — NO_TRACK_ID marks invoice as ERROR
// ─────────────────────────────────────────────────────────────
describe('FIX 6 — no trackId after failed reconciliation marks invoice as ERROR', () => {
  it('marks invoice ERROR when trackId is null and DGII reconciliation returns nothing', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ trackId: null }));

    // DGII queryTrackIds returns empty (no trackId to recover)
    m.dgiiService.queryTrackIds.mockResolvedValue({
      status: 0,
      message: '[]',
      rawResponse: '[]',
    });

    const result = await m.processor.process(makeJob());

    expect(result.status).toBe('NO_TRACK_ID');

    // FIX 6 — must update status to ERROR
    expect(m.prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InvoiceStatus.ERROR,
          dgiiMessage: expect.stringContaining('trackId'),
        }),
      }),
    );
  });

  it('marks invoice ERROR when trackId is null and reconciliation throws', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ trackId: null }));

    // Network error during reconciliation
    m.dgiiService.queryTrackIds.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await m.processor.process(makeJob());

    expect(result.status).toBe('NO_TRACK_ID');
    expect(m.prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InvoiceStatus.ERROR,
        }),
      }),
    );
  });

  it('does NOT mark ERROR when trackId is recovered from DGII — reschedules instead', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(makeInvoice({ trackId: null }));

    // Reconciliation succeeds — DGII returns a trackId
    m.dgiiService.queryTrackIds.mockResolvedValue({
      status: 1,
      message: JSON.stringify([{ trackId: 'RECOVERED-TRACK' }]),
      rawResponse: '',
    });

    const job = makeJob();
    job.moveToDelayed.mockResolvedValue(undefined);
    job.updateData.mockResolvedValue(undefined);

    // Should throw DelayedError (rescheduled with recovered trackId)
    await expect(m.processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    // Must NOT have updated to ERROR
    const errorUpdates = m.prisma.invoice.update.mock.calls.filter(
      (c: any[]) => c[0].data?.status === InvoiceStatus.ERROR,
    );
    expect(errorUpdates.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// FIX H1 — REJECTED via poller refunds the reserved quota
// ─────────────────────────────────────────────────────────────
describe('FIX H1 — REJECTED verdict via poller reverts usage', () => {
  it('calls revertUsage(invoiceId, companyId) exactly once on REJECTED transition', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ status: InvoiceStatus.PROCESSING, trackId: 'TRACK-001' }),
    );
    // DGII status 2 → REJECTED (final)
    m.dgiiService.queryStatus.mockResolvedValue({ status: 2, message: 'Rechazado por DGII', rawResponse: '' });

    const result = await m.processor.process(makeJob());

    expect(result.status).toBe(InvoiceStatus.REJECTED);
    expect(m.usageService.revertUsage).toHaveBeenCalledTimes(1);
    expect(m.usageService.revertUsage).toHaveBeenCalledWith('invoice-1', 'company-1');
    // Webhook for rejection still fires
    expect(m.webhooksService.emit).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.objectContaining({ invoiceId: 'invoice-1' }),
    );
  });

  it('does NOT revert usage on ACCEPTED transition', async () => {
    const m = makeProcessor();
    m.prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ status: InvoiceStatus.PROCESSING, trackId: 'TRACK-001' }),
    );
    // DGII status 1 → ACCEPTED (final)
    m.dgiiService.queryStatus.mockResolvedValue({ status: 1, message: 'Aceptado', rawResponse: '' });

    const result = await m.processor.process(makeJob());

    expect(result.status).toBe(InvoiceStatus.ACCEPTED);
    expect(m.usageService.revertUsage).not.toHaveBeenCalled();
  });

  it('a REJECTED invoice already final short-circuits — no extra revert (idempotent re-poll)', async () => {
    const m = makeProcessor();
    // Second poll finds the invoice already REJECTED → early return, no revert call here.
    m.prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ status: InvoiceStatus.REJECTED, trackId: 'TRACK-001' }),
    );

    const result = await m.processor.process(makeJob());

    expect(result.final).toBe(true);
    expect(m.usageService.revertUsage).not.toHaveBeenCalled();
  });
});
