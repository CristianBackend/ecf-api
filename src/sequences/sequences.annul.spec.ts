/**
 * SequencesService.annulSequences — unit tests for FIX 2 (C1b) / FIX 4.
 *
 * FIX 2: ANECF may now annul ranges already "consumed" locally (<= currentNumber)
 * — gaps (secuencial consumed with no invoice) and terminally-failed e-CF
 * (REJECTED/ERROR) — while still BLOCKING any eNCF backed by an ACCEPTED invoice
 * (that path requires a Credit Note E34, not ANECF). Per DGII Norma 01-2020.
 *
 * FIX 4: a rejected eNCF is a valid ANECF candidate (covered here + in
 * ecf-processing.processor.spec.ts which proves REJECTED persists the eNCF).
 *
 * All DGII-adjacent deps are mocked; no live DB / network.
 */
import { BadRequestException } from '@nestjs/common';
import { SequencesService } from './sequences.service';
import { InvoiceStatus } from '@prisma/client';
import { makeTestLogger } from '../common/logger/test-logger';

type Mock = jest.Mock;

function makeCompany(overrides: Partial<any> = {}) {
  return {
    id: 'company-1',
    tenantId: 'tenant-1',
    rnc: '131234567',
    businessName: 'Emisor SRL',
    tradeName: null,
    address: 'Av. Principal',
    dgiiEnv: 'CERT',
    isActive: true,
    ...overrides,
  };
}

function makeSequenceRow(overrides: Partial<any> = {}) {
  return {
    id: 'seq-1',
    tenantId: 'tenant-1',
    companyId: 'company-1',
    ecfType: 'E32',
    prefix: 'E32',
    startNumber: 1,
    currentNumber: 10,
    endNumber: 50,
    isActive: true,
    ...overrides,
  };
}

function makeMocks() {
  const prisma: any = {
    company: { findFirst: jest.fn() as Mock },
    sequence: {
      findFirst: jest.fn() as Mock,
      update: jest.fn(async () => ({})) as Mock,
    },
    invoice: { findMany: jest.fn(async () => []) as Mock },
    sequenceAnnulment: {
      create: jest.fn(async () => ({ id: 'anecf-1' })) as Mock,
      updateMany: jest.fn(async () => ({ count: 1 })) as Mock,
    },
    auditLog: { create: jest.fn(async () => ({})) as Mock },
    // FOR UPDATE lock inside the ACCEPTED transaction.
    $queryRawUnsafe: jest.fn(async () => [{ currentNumber: 10 }]) as Mock,
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));

  const signingService = {
    extractFromP12: jest.fn(() => ({ privateKey: 'PK', certificate: 'CERT' })) as Mock,
    signXml: jest.fn(() => ({ signedXml: '<ANECF><Signature/></ANECF>' })) as Mock,
  };
  const dgiiService = {
    getToken: jest.fn(async () => 'token-abc') as Mock,
    submitAnecf: jest.fn(async () => ({
      success: true,
      status: 1,
      message: 'Aceptado',
      rawResponse: 'OK',
      trackId: 'TRACK-ANECF',
    })) as Mock,
  };
  const certificatesService = {
    getDecryptedCertificate: jest.fn(async () => ({
      p12Buffer: Buffer.from('p12'),
      passphrase: 'pw',
    })) as Mock,
  };
  const xmlBuilder = {
    buildAnecfXml: jest.fn(() => '<ANECF/>') as Mock,
  };

  return { prisma, signingService, dgiiService, certificatesService, xmlBuilder };
}

function buildService(m: ReturnType<typeof makeMocks>) {
  return new SequencesService(
    m.prisma,
    m.signingService as any,
    m.dgiiService as any,
    m.certificatesService as any,
    m.xmlBuilder as any,
    makeTestLogger(),
  );
}

describe('SequencesService.annulSequences — FIX 2 (anular huecos / consumidos)', () => {
  let m: ReturnType<typeof makeMocks>;
  let svc: SequencesService;

  beforeEach(() => {
    m = makeMocks();
    svc = buildService(m);
    m.prisma.company.findFirst.mockResolvedValue(makeCompany());
    m.prisma.sequence.findFirst.mockResolvedValue(makeSequenceRow());
  });

  it('anula un rango YA consumido (<= currentNumber) cuando no hay factura no-anulable', async () => {
    // Range E320000000003..E320000000005 is entirely below currentNumber=10.
    // No blocking invoice → allowed (a gap or REJECTED/ERROR sub-range).
    m.prisma.invoice.findMany.mockResolvedValue([]);

    const result = await svc.annulSequences('tenant-1', 'company-1', [
      { encfFrom: 'E320000000003', encfTo: 'E320000000005' },
    ]);

    // Blocking query ran on the below-current sub-range, excluding annullable states.
    expect(m.prisma.invoice.findMany).toHaveBeenCalledTimes(1);
    const where = m.prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.status.notIn).toEqual(
      expect.arrayContaining([InvoiceStatus.REJECTED, InvoiceStatus.ERROR]),
    );

    // ANECF was actually built, signed and submitted to DGII.
    expect(m.dgiiService.submitAnecf).toHaveBeenCalledTimes(1);
    expect(result.trackId).toBe('TRACK-ANECF');
    // Audit trail written.
    const audit = m.prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('sequences_annulled');
  });

  it('BLOQUEA anular un eNCF con factura ACCEPTED (requiere Nota de Crédito E34)', async () => {
    // The below-current blocking query finds an ACCEPTED invoice → must reject.
    m.prisma.invoice.findMany.mockResolvedValue([
      { encf: 'E320000000004', status: InvoiceStatus.ACCEPTED },
    ]);

    await expect(
      svc.annulSequences('tenant-1', 'company-1', [
        { encfFrom: 'E320000000003', encfTo: 'E320000000005' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was sent to DGII.
    expect(m.dgiiService.submitAnecf).not.toHaveBeenCalled();
    expect(m.prisma.sequenceAnnulment.create).not.toHaveBeenCalled();
  });

  it('FIX 4: un eNCF RECHAZADO es anulable vía ANECF (no bloquea)', async () => {
    // A REJECTED invoice occupies E320000000004, but the blocking query filters
    // OUT annullable states (notIn REJECTED/ERROR), so it returns empty → allowed.
    m.prisma.invoice.findMany.mockResolvedValue([]);

    await expect(
      svc.annulSequences('tenant-1', 'company-1', [
        { encfFrom: 'E320000000004', encfTo: 'E320000000004' },
      ]),
    ).resolves.toMatchObject({ trackId: 'TRACK-ANECF' });

    expect(m.dgiiService.submitAnecf).toHaveBeenCalledTimes(1);
  });

  it('regresión: anular [currentNumber+1 .. endNumber] desactiva la secuencia', async () => {
    // Future-only range: no below-current blocking query at all.
    const result = await svc.annulSequences('tenant-1', 'company-1', [
      { encfFrom: 'E320000000011', encfTo: 'E320000000050' },
    ]);

    expect(m.prisma.invoice.findMany).not.toHaveBeenCalled();
    // Applied locally: the sequence was deactivated so getNextEncf can't emit into it.
    const deactivated = m.prisma.sequence.update.mock.calls
      .map((c: any) => c[0].data)
      .some((d: any) => d.isActive === false);
    expect(deactivated).toBe(true);
    expect(result.trackId).toBe('TRACK-ANECF');
  });

  it('rechaza rangos fuera de la secuencia registrada', async () => {
    await expect(
      svc.annulSequences('tenant-1', 'company-1', [
        { encfFrom: 'E320000000045', encfTo: 'E320000000060' }, // 60 > endNumber 50
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.dgiiService.submitAnecf).not.toHaveBeenCalled();
  });
});
