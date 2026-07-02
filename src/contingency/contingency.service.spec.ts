/**
 * ContingencyService — FIX 3 (C2) audit-trail tests.
 *
 * The contingency pipeline is part of the invoice lifecycle, so every state
 * transition it drives must leave an audit_log row (actor 'system:contingency'):
 *   - markForRetry            → contingency_entered
 *   - reconcile existing tid  → contingency_exited (via: 'reconcile')
 *   - resubmit (no trackId)   → contingency_exited (via: 'resubmit')
 *   - 72h window exceeded     → failed
 *   - resubmit throws         → failed
 *
 * All DGII-adjacent deps are mocked; no live DB / network.
 */
import { ContingencyService } from './contingency.service';
import { InvoiceStatus } from '@prisma/client';
import { makeTestLogger } from '../common/logger/test-logger';

type Mock = jest.Mock;

function makeInvoice(overrides: Partial<any> = {}) {
  return {
    id: 'invoice-1',
    tenantId: 'tenant-1',
    companyId: 'company-1',
    encf: 'E310000000001',
    ecfType: 'E31',
    status: InvoiceStatus.CONTINGENCY,
    trackId: null,
    xmlUnsigned: '<ECF/>',
    xmlRfce: null,
    totalAmount: 1180,
    createdAt: new Date(), // within the 72h window
    company: { rnc: '131234567', businessName: 'Emisor SRL', dgiiEnv: 'CERT' },
    ...overrides,
  };
}

function makeMocks() {
  const prisma: any = {
    invoice: {
      findFirst: jest.fn() as Mock,
      findMany: jest.fn() as Mock,
      update: jest.fn(async () => ({})) as Mock,
      updateMany: jest.fn(async () => ({ count: 0 })) as Mock,
      count: jest.fn(async () => 0) as Mock,
    },
    auditLog: { create: jest.fn(async () => ({})) as Mock },
  };
  const signingService = {
    extractFromP12: jest.fn(() => ({ privateKey: 'PK', certificate: 'CERT' })) as Mock,
    signXml: jest.fn(() => ({ signedXml: '<ECF><Signature/></ECF>', securityCode: 'ABC123' })) as Mock,
  };
  const dgiiService = {
    getToken: jest.fn(async () => 'token-abc') as Mock,
    queryStatus: jest.fn() as Mock,
    submitEcf: jest.fn() as Mock,
    submitRfce: jest.fn() as Mock,
  };
  const certificatesService = {
    getDecryptedCertificate: jest.fn(async () => ({ p12Buffer: Buffer.from('p12'), passphrase: 'pw' })) as Mock,
  };
  const queueService = { enqueueStatusPoll: jest.fn(async () => ({})) as Mock };
  const usageService = { revertUsage: jest.fn(async () => undefined) as Mock };

  return { prisma, signingService, dgiiService, certificatesService, queueService, usageService };
}

function buildService(m: ReturnType<typeof makeMocks>) {
  return new ContingencyService(
    m.prisma,
    m.signingService as any,
    m.dgiiService as any,
    m.certificatesService as any,
    m.queueService as any,
    m.usageService as any,
    makeTestLogger(),
  );
}

const actions = (m: ReturnType<typeof makeMocks>) =>
  m.prisma.auditLog.create.mock.calls.map((c: any) => c[0].data.action);

describe('ContingencyService — FIX 3 audit trail', () => {
  let m: ReturnType<typeof makeMocks>;
  let svc: ContingencyService;

  beforeEach(() => {
    m = makeMocks();
    svc = buildService(m);
  });

  it('markForRetry escribe contingency_entered (actor system:contingency)', async () => {
    m.prisma.invoice.findFirst.mockResolvedValue(
      makeInvoice({ status: InvoiceStatus.ERROR }),
    );

    await svc.markForRetry('tenant-1', 'invoice-1');

    expect(actions(m)).toContain('contingency_entered');
    const audit = m.prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.actor).toBe('system:contingency');
    expect(audit.entityType).toBe('invoice');
  });

  it('reconcile (trackId existente) escribe contingency_exited via=reconcile', async () => {
    m.prisma.invoice.findMany.mockResolvedValue([makeInvoice({ trackId: 'TRACK-1' })]);
    m.dgiiService.queryStatus.mockResolvedValue({ status: 1, message: 'Aceptado' }); // ACCEPTED

    const res = await svc.processQueue('tenant-1');

    expect(res.processed).toBe(1);
    const exited = m.prisma.auditLog.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.action === 'contingency_exited');
    expect(exited).toBeDefined();
    expect(exited.metadata.via).toBe('reconcile');
    // Reconcile must NOT resubmit (avoids duplicate e-CF at DGII).
    expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
  });

  it('resubmit (sin trackId) escribe contingency_exited via=resubmit', async () => {
    m.prisma.invoice.findMany.mockResolvedValue([makeInvoice({ trackId: null })]);
    m.dgiiService.submitEcf.mockResolvedValue({ status: 1, trackId: 'TRACK-NEW', message: 'Aceptado' });

    const res = await svc.processQueue('tenant-1');

    expect(res.processed).toBe(1);
    const exited = m.prisma.auditLog.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.action === 'contingency_exited');
    expect(exited).toBeDefined();
    expect(exited.metadata.via).toBe('resubmit');
    expect(m.dgiiService.submitEcf).toHaveBeenCalledTimes(1);
  });

  it('ventana de 72h excedida escribe failed', async () => {
    const old = new Date(Date.now() - 73 * 60 * 60 * 1000); // 73h ago
    m.prisma.invoice.findMany.mockResolvedValue([makeInvoice({ createdAt: old })]);

    const res = await svc.processQueue('tenant-1');

    expect(res.failed).toBe(1);
    const failed = m.prisma.auditLog.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.action === 'failed');
    expect(failed).toBeDefined();
    expect(failed.metadata.reason).toMatch(/72 horas/);
    expect(m.dgiiService.submitEcf).not.toHaveBeenCalled();
  });

  it('resubmit que falla escribe failed', async () => {
    m.prisma.invoice.findMany.mockResolvedValue([makeInvoice({ trackId: null })]);
    m.dgiiService.submitEcf.mockRejectedValue(new Error('DGII 500'));

    const res = await svc.processQueue('tenant-1');

    expect(res.failed).toBe(1);
    expect(actions(m)).toContain('failed');
  });
});
