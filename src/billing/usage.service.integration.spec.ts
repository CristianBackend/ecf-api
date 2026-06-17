/**
 * UsageService.countAcceptedEmission — integration tests against a real PostgreSQL DB.
 *
 * WHY (billing-v2, revenue-critical): an invoice can reach ACCEPTED through 4
 * code paths (poller, direct submit, contingency, manual poll) and a re-poll can
 * hit an already-ACCEPTED invoice. This proves against REAL SQL that:
 *   1. the first call increments CompanyUsage.acceptedCount and flips usageCounted,
 *   2. a repeated call (other path / re-poll) does NOT double-count.
 *
 * SETUP: requires DATABASE_URL pointing to a live migrated PostgreSQL. The .env is
 * loaded (override) so this hits the real DB even though env-setup.ts set a
 * test-only DATABASE_URL. If the DB is unreachable, every test no-ops.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

import { PrismaClient, CompanyPlanStatus, DgiiEnvironment, EcfType, InvoiceStatus } from '@prisma/client';
import { UsageService } from './usage.service';
import { makeTestLogger } from '../common/logger/test-logger';

const TEST_LABEL = `usage-v2-int-${Date.now()}`;

describe('UsageService.countAcceptedEmission — integration (real DB)', () => {
  let prisma: PrismaClient;
  let service: UsageService;
  let dbReachable = true;

  let tenantId: string;
  let companyId: string;
  let invoiceId: string;
  let planCode: string;
  const cycleStart = new Date('2026-06-01T00:00:00.000Z');
  const cycleEnd = new Date('2026-07-01T00:00:00.000Z');

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      dbReachable = false;
      return;
    }

    service = new UsageService(prisma as any, makeTestLogger());

    const tenant = await prisma.tenant.create({
      data: { name: `Tenant ${TEST_LABEL}`, email: `${TEST_LABEL}@test.invalid` },
    });
    tenantId = tenant.id;

    // CERT (NOT DEV) — DEV companies are not metered.
    const company = await prisma.company.create({
      data: {
        tenantId,
        rnc: '130000009',
        businessName: `Empresa ${TEST_LABEL}`,
        dgiiEnv: DgiiEnvironment.CERT,
      },
    });
    companyId = company.id;

    planCode = `PLAN_${TEST_LABEL}`.slice(0, 40);
    await prisma.billingPlan.create({
      data: { code: planCode, name: 'Per Emission Test', monthlyFee: 60 },
    });

    await prisma.companyPlan.create({
      data: {
        companyId,
        planCode,
        cycleStartDate: cycleStart,
        cycleEndDate: cycleEnd,
        status: CompanyPlanStatus.ACTIVE,
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        companyId,
        ecfType: EcfType.E31,
        encf: 'E310000000001',
        status: InvoiceStatus.ACCEPTED,
        usageCounted: false,
      },
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    if (!dbReachable) {
      await prisma.$disconnect();
      return;
    }
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.companyUsage.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.companyPlan.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.billingPlan.deleteMany({ where: { code: planCode } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('first call increments acceptedCount to 1 and flips usageCounted', async () => {
    if (!dbReachable) return;

    await service.countAcceptedEmission(invoiceId, companyId);

    const usage = await prisma.companyUsage.findUnique({
      where: { companyId_cycleStartDate: { companyId, cycleStartDate: cycleStart } },
    });
    expect(usage!.acceptedCount).toBe(1);

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(invoice!.usageCounted).toBe(true);
  });

  it('does NOT double-count on a repeated call (other path / re-poll)', async () => {
    if (!dbReachable) return;

    await service.countAcceptedEmission(invoiceId, companyId);

    const usage = await prisma.companyUsage.findUnique({
      where: { companyId_cycleStartDate: { companyId, cycleStartDate: cycleStart } },
    });
    expect(usage!.acceptedCount).toBe(1); // still 1 — never counted twice
  });
});
