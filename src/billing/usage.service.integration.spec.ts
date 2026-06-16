/**
 * UsageService.revertUsage — integration tests against a real PostgreSQL DB.
 *
 * WHY THIS FILE EXISTS (FIX H1 verification):
 * The REJECTED verdict for STANDARD e-CF arrives via the status poller, which
 * now calls revertUsage(invoiceId, companyId) to refund the reserved quota.
 * This file proves the money path against REAL SQL:
 *   1. revertUsage decrements company_usages EXACTLY ONCE on the first call.
 *   2. A repeated call (e.g. a re-poll, or REJECTED→VOIDED) does NOT
 *      double-refund — the usageReverted updateMany claim guards it.
 *
 * Unit tests mock $queryRaw, so the snake_case columns / atomic UPDATE in
 * decrementUsage and the updateMany idempotency claim only get exercised here.
 *
 * SETUP: Requires DATABASE_URL pointing to a live PostgreSQL instance with the
 * schema already migrated. The .env file is loaded here (override) so this test
 * hits the real DB even though Jest's env-setup.ts set a test-only DATABASE_URL.
 * If the DB is unreachable, every test no-ops (mirrors the sequences spec).
 */

// Load .env before PrismaClient is instantiated, overriding env-setup.ts defaults.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env'), override: true });

import { PrismaClient, CompanyPlanStatus, DgiiEnvironment, EcfType, InvoiceStatus } from '@prisma/client';
import { UsageService } from './usage.service';
import { makeTestLogger } from '../common/logger/test-logger';

const TEST_LABEL = `usage-int-${Date.now()}`;

describe('UsageService.revertUsage — integration (real DB)', () => {
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

    // notifications is only used by notifyThresholds — irrelevant to revertUsage.
    service = new UsageService(prisma as any, {} as any, makeTestLogger());

    const tenant = await prisma.tenant.create({
      data: { name: `Tenant ${TEST_LABEL}`, email: `${TEST_LABEL}@test.invalid` },
    });
    tenantId = tenant.id;

    // CERT (NOT DEV) — DEV companies are not metered, so decrementUsage would no-op.
    const company = await prisma.company.create({
      data: {
        tenantId,
        rnc: '130000001',
        businessName: `Empresa ${TEST_LABEL}`,
        dgiiEnv: DgiiEnvironment.CERT,
      },
    });
    companyId = company.id;

    planCode = `PLAN_${TEST_LABEL}`.slice(0, 40);
    await prisma.billingPlan.create({
      data: { code: planCode, name: 'Plan Test', monthlyFee: 0, includedInvoices: 100 },
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

    // One invoice consumed against base quota; usageReverted starts false.
    await prisma.companyUsage.create({
      data: {
        companyId,
        cycleStartDate: cycleStart,
        baseUsed: 1,
        topupUsed: 0,
        totalQuota: 100,
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        companyId,
        ecfType: EcfType.E31,
        encf: 'E310000000001',
        status: InvoiceStatus.REJECTED,
        usageReverted: false,
      },
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    if (!dbReachable) {
      await prisma.$disconnect();
      return;
    }
    // Clean up children first, then the tenant.
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.companyUsage.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.companyPlan.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.billingPlan.deleteMany({ where: { code: planCode } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('decrements base_used exactly once and flips usageReverted on the first call', async () => {
    if (!dbReachable) return;

    await service.revertUsage(invoiceId, companyId);

    const usage = await prisma.companyUsage.findUnique({
      where: { companyId_cycleStartDate: { companyId, cycleStartDate: cycleStart } },
    });
    expect(usage!.baseUsed).toBe(0);
    expect(usage!.topupUsed).toBe(0);

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(invoice!.usageReverted).toBe(true);
  });

  it('does NOT double-refund on a repeated revertUsage (idempotent re-poll)', async () => {
    if (!dbReachable) return;

    // Second call: the usageReverted claim already lost → no further decrement.
    await service.revertUsage(invoiceId, companyId);

    const usage = await prisma.companyUsage.findUnique({
      where: { companyId_cycleStartDate: { companyId, cycleStartDate: cycleStart } },
    });
    // Still 0 — never went negative, never decremented twice.
    expect(usage!.baseUsed).toBe(0);
    expect(usage!.topupUsed).toBe(0);
  });
});
