/**
 * SequencesService.getNextEncf — integration tests against a real PostgreSQL DB.
 *
 * WHY THIS FILE EXISTS:
 * The getNextEncf() method uses a raw SELECT FOR UPDATE query. A previous version
 * of the query used `FROM "Sequence"` (wrong: table is `sequences`) and camelCase
 * column names in WHERE (wrong: columns are snake_case due to @map in schema).
 * Those bugs went undetected because all unit tests mock $queryRawUnsafe.
 *
 * This file is the regression guard: it creates real rows, runs real queries,
 * and fails if the raw SQL ever regresses to wrong table/column names.
 *
 * SETUP: Requires DATABASE_URL pointing to a live PostgreSQL instance with the
 * schema already migrated. The .env file is loaded here (with override) so that
 * this test uses the real DB even when Jest's env-setup.ts has already set a
 * test-only DATABASE_URL.
 */

// Load .env before PrismaClient is instantiated, overriding env-setup.ts defaults.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

import { PrismaClient, EcfType } from '@prisma/client';
import { SequencesService } from './sequences.service';
import { makeTestLogger } from '../common/logger/test-logger';
import { BadRequestException } from '@nestjs/common';

const TEST_LABEL = `integration-${Date.now()}`;

describe('SequencesService.getNextEncf — integration (real DB)', () => {
  let prisma: PrismaClient;
  let svc: SequencesService;
  let tenantId: string;
  let companyId: string;
  let sequenceId: string;
  let dbReachable = true;

  beforeAll(async () => {
    prisma = new PrismaClient();

    try {
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      dbReachable = false;
      return;
    }

    svc = new SequencesService(
      prisma as any,
      {} as any, // signingService — unused by getNextEncf
      {} as any, // dgiiService
      {} as any, // certificatesService
      {} as any, // xmlBuilder
      makeTestLogger(),
    );

    const tenant = await prisma.tenant.create({
      data: { name: `Test Tenant ${TEST_LABEL}`, email: `${TEST_LABEL}@test.invalid` },
    });
    tenantId = tenant.id;

    const company = await prisma.company.create({
      data: {
        tenantId,
        rnc: '999999999',
        businessName: `Test Co ${TEST_LABEL}`,
        dgiiEnv: 'DEV',
        isActive: true,
      },
    });
    companyId = company.id;

    const sequence = await prisma.sequence.create({
      data: {
        tenantId,
        companyId,
        ecfType: EcfType.E32,
        prefix: 'E32',
        startNumber: 1,
        currentNumber: 0,
        endNumber: 50,
        isActive: true,
      },
    });
    sequenceId = sequence.id;
  });

  afterAll(async () => {
    if (!dbReachable) { await prisma.$disconnect(); return; }
    // Cascade delete via Tenant (Tenant→Company→Sequence)
    if (tenantId) {
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('DB reachable — skips gracefully if not', () => {
    if (!dbReachable) {
      console.warn('Integration test skipped: DB not reachable');
    }
    expect(true).toBe(true);
  });

  it('without override → returns E320000000001 and increments currentNumber to 1', async () => {
    if (!dbReachable) return;

    const encf = await svc.getNextEncf(tenantId, companyId, EcfType.E32);

    expect(encf).toBe('E320000000001');
    const seq = await prisma.sequence.findUnique({ where: { id: sequenceId } });
    expect(seq!.currentNumber).toBe(1);
  });

  it('with override=15 → returns E320000000015, currentNumber advances to 15', async () => {
    if (!dbReachable) return;

    const encf = await svc.getNextEncf(tenantId, companyId, EcfType.E32, 15);

    expect(encf).toBe('E320000000015');
    const seq = await prisma.sequence.findUnique({ where: { id: sequenceId } });
    expect(seq!.currentNumber).toBe(15);
  });

  it('override does not go backwards — override=5 (< currentNumber=15) keeps currentNumber=15', async () => {
    if (!dbReachable) return;

    const encf = await svc.getNextEncf(tenantId, companyId, EcfType.E32, 5);

    expect(encf).toBe('E320000000005');
    const seq = await prisma.sequence.findUnique({ where: { id: sequenceId } });
    // MAX(15, 5) = 15 — counter must not go backward
    expect(seq!.currentNumber).toBe(15);
  });

  it('override > endNumber → BadRequestException', async () => {
    if (!dbReachable) return;

    await expect(
      svc.getNextEncf(tenantId, companyId, EcfType.E32, 51),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
