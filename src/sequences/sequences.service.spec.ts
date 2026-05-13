/**
 * SequencesService.getNextEncf — unit tests for encfOverride support.
 *
 * Only prisma and logger are needed; the other constructor deps (signing,
 * dgii, certificates, xmlBuilder) are unused by getNextEncf and are passed
 * as empty stubs.
 */
import { BadRequestException } from '@nestjs/common';
import { SequencesService } from './sequences.service';
import { EcfType } from '@prisma/client';
import { makeTestLogger } from '../common/logger/test-logger';

function makeSequenceRow(overrides: Partial<any> = {}) {
  return {
    id: 'seq-uuid-1',
    tenantId: 'tenant-1',
    companyId: 'company-1',
    ecfType: 'E32',
    prefix: 'E32',
    startNumber: 1,
    endNumber: 50,
    currentNumber: 3,
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

function makePrisma(sequenceRow: any | null) {
  const tx: any = {
    $queryRawUnsafe: jest.fn().mockResolvedValue(sequenceRow ? [sequenceRow] : []),
    sequence: {
      update: jest.fn().mockResolvedValue({}),
    },
  };
  return {
    prisma: {
      $transaction: jest.fn((fn: any) => fn(tx)),
    } as any,
    tx,
  };
}

function buildService(prisma: any) {
  return new SequencesService(
    prisma,
    {} as any, // signingService — unused by getNextEncf
    {} as any, // dgiiService
    {} as any, // certificatesService
    {} as any, // xmlBuilder
    makeTestLogger(),
  );
}

describe('SequencesService.getNextEncf — encfOverride', () => {
  it('1. override válido dentro del rango → devuelve ENCF con el número forzado', async () => {
    const row = makeSequenceRow({ currentNumber: 3 });
    const { prisma } = makePrisma(row);
    const svc = buildService(prisma);

    const encf = await svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 15);

    expect(encf).toBe('E320000000015');
  });

  it('2. override > endNumber → BadRequestException', async () => {
    const row = makeSequenceRow({ endNumber: 50 });
    const { prisma } = makePrisma(row);
    const svc = buildService(prisma);

    await expect(
      svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 51),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('3. override < startNumber → BadRequestException', async () => {
    const row = makeSequenceRow({ startNumber: 5, endNumber: 50, currentNumber: 5 });
    const { prisma } = makePrisma(row);
    const svc = buildService(prisma);

    await expect(
      svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 3),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('4. override con secuencia expirada → BadRequestException (expiración tiene prioridad)', async () => {
    const row = makeSequenceRow({ expiresAt: new Date('2020-01-01') });
    const { prisma } = makePrisma(row);
    const svc = buildService(prisma);

    await expect(
      svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 5),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('5. override actualiza currentNumber al máximo (override > current)', async () => {
    const row = makeSequenceRow({ currentNumber: 3 });
    const { prisma, tx } = makePrisma(row);
    const svc = buildService(prisma);

    await svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 20);

    expect(tx.sequence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentNumber: 20 } }),
    );
  });

  it('5b. override no retrocede currentNumber cuando override < current', async () => {
    const row = makeSequenceRow({ currentNumber: 30 });
    const { prisma, tx } = makePrisma(row);
    const svc = buildService(prisma);

    const encf = await svc.getNextEncf('tenant-1', 'company-1', EcfType.E32, 5);

    // ENCF usa el override, pero currentNumber no retrocede
    expect(encf).toBe('E320000000005');
    expect(tx.sequence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentNumber: 30 } }),
    );
  });

  it('6. sin override → comportamiento original (currentNumber + 1, test de regresión)', async () => {
    const row = makeSequenceRow({ prefix: 'E31', currentNumber: 7 });
    const { prisma, tx } = makePrisma(row);
    const svc = buildService(prisma);

    const encf = await svc.getNextEncf('tenant-1', 'company-1', EcfType.E31);

    expect(encf).toBe('E310000000008');
    expect(tx.sequence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentNumber: 8 } }),
    );
  });
});
