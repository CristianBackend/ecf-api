import { AdminPlansService } from './admin-plans.service';
import { makeTestLogger } from '../common/logger/test-logger';

const PLAN = {
  id: 'plan-id-1',
  code: 'TIER_1',
  name: 'Tier 1',
  isActive: true,
  sortOrder: 1,
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  pricingTiers: [],
};

const NOW = new Date('2026-05-06T12:00:00.000Z');
const CYCLE_START = new Date('2026-05-01T00:00:00.000Z');

function makePrisma() {
  return {
    billingPlan: {
      findMany: jest.fn().mockResolvedValue([PLAN]),
    },
    companyPlan: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    companyUsage: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new AdminPlansService(prisma as any, makeTestLogger());
}

/** Build an ACTIVE companyPlan row as returned by findMany (with includes). */
function makeCompanyPlan(overrides: Partial<{
  companyId: string;
  businessName: string;
  planCode: string;
  cycleStartDate: Date;
  pricingTiers: any[];
}> = {}) {
  const companyId = overrides.companyId ?? 'company-1';
  return {
    companyId,
    planCode: overrides.planCode ?? 'TIER_1',
    cycleStartDate: overrides.cycleStartDate ?? CYCLE_START,
    company: { businessName: overrides.businessName ?? 'Acme Corp' },
    plan: { pricingTiers: overrides.pricingTiers ?? [] },
  };
}

describe('AdminPlansService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: AdminPlansService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = makePrisma();
    service = makeService(prisma);
  });

  afterEach(() => jest.useRealTimers());

  // ── listPlans ───────────────────────────────────────────────────────────────

  it('listPlans returns active plans and queries with isActive + pricingTiers include', async () => {
    prisma.billingPlan.findMany.mockResolvedValue([PLAN]);

    const result = await service.listPlans();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(PLAN);
    expect(prisma.billingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: expect.objectContaining({
          pricingTiers: expect.objectContaining({ orderBy: { sortOrder: 'asc' } }),
        }),
      }),
    );
  });

  // ── getDashboard ──────────────────────────────────────────────────────────────

  it('getDashboard aggregates revenue from active company plans', async () => {
    // company-1: accepted 2000 → billed 2000 (range 0.04) → 60 + 80 = 140
    // company-2: accepted 0    → billed 500  (range 0.06) → 60 + 30 = 90
    // expectedMonthlyRevenue = 230
    prisma.companyPlan.findMany.mockResolvedValue([
      makeCompanyPlan({ companyId: 'company-1', businessName: 'Acme', cycleStartDate: CYCLE_START }),
      makeCompanyPlan({ companyId: 'company-2', businessName: 'Beta', cycleStartDate: CYCLE_START }),
    ]);
    prisma.companyUsage.findUnique
      .mockResolvedValueOnce({ acceptedCount: 2000 })
      .mockResolvedValueOnce({ acceptedCount: 0 });

    const result = await service.getDashboard();

    expect(result.totalActivePlans).toBe(2);
    expect(result.companiesRequiringQuote).toBe(0);
    expect(result.expectedMonthlyRevenue).toBe(230);
    expect(result.companies).toHaveLength(2);

    expect(result.companies[0]).toMatchObject({
      companyId: 'company-1',
      name: 'Acme',
      planCode: 'TIER_1',
      acceptedCount: 2000,
      total: 140,
      requiresQuote: false,
    });
    expect(result.companies[1]).toMatchObject({
      companyId: 'company-2',
      name: 'Beta',
      acceptedCount: 0,
      total: 90,
      requiresQuote: false,
    });
  });

  it('getDashboard queries active plans (status ACTIVE, cycleEndDate in the future) and usage by composite key', async () => {
    prisma.companyPlan.findMany.mockResolvedValue([
      makeCompanyPlan({ companyId: 'company-1', cycleStartDate: CYCLE_START }),
    ]);
    prisma.companyUsage.findUnique.mockResolvedValue({ acceptedCount: 2000 });

    await service.getDashboard();

    expect(prisma.companyPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          cycleEndDate: { gt: NOW },
        }),
        include: expect.objectContaining({
          company: true,
          plan: expect.objectContaining({ include: { pricingTiers: true } }),
        }),
      }),
    );
    expect(prisma.companyUsage.findUnique).toHaveBeenCalledWith({
      where: {
        companyId_cycleStartDate: {
          companyId: 'company-1',
          cycleStartDate: CYCLE_START,
        },
      },
    });
  });

  it('getDashboard counts quote-only companies separately and excludes them from revenue', async () => {
    // company-1: accepted 2000 → total 140 (counts toward revenue)
    // company-2: accepted 50000 → range 10001-100000 → requiresQuote, total null
    prisma.companyPlan.findMany.mockResolvedValue([
      makeCompanyPlan({ companyId: 'company-1', businessName: 'Acme' }),
      makeCompanyPlan({ companyId: 'company-2', businessName: 'BigCo' }),
    ]);
    prisma.companyUsage.findUnique
      .mockResolvedValueOnce({ acceptedCount: 2000 })
      .mockResolvedValueOnce({ acceptedCount: 50000 });

    const result = await service.getDashboard();

    expect(result.totalActivePlans).toBe(2);
    expect(result.companiesRequiringQuote).toBe(1);
    // Only company-1's 140 contributes; the quote company adds nothing.
    expect(result.expectedMonthlyRevenue).toBe(140);

    const bigCo = result.companies.find((c) => c.companyId === 'company-2')!;
    expect(bigCo.requiresQuote).toBe(true);
    expect(bigCo.total).toBeNull();
    expect(bigCo.acceptedCount).toBe(50000);
  });

  it('getDashboard treats missing usage as 0 accepted (billed minimum 500 → total 90)', async () => {
    prisma.companyPlan.findMany.mockResolvedValue([
      makeCompanyPlan({ companyId: 'company-1' }),
    ]);
    prisma.companyUsage.findUnique.mockResolvedValue(null);

    const result = await service.getDashboard();

    expect(result.companies[0].acceptedCount).toBe(0);
    expect(result.companies[0].total).toBe(90);
    expect(result.expectedMonthlyRevenue).toBe(90);
  });

  it('getDashboard returns zeros when there are no active plans', async () => {
    prisma.companyPlan.findMany.mockResolvedValue([]);

    const result = await service.getDashboard();

    expect(result.totalActivePlans).toBe(0);
    expect(result.expectedMonthlyRevenue).toBe(0);
    expect(result.companiesRequiringQuote).toBe(0);
    expect(result.companies).toEqual([]);
    expect(prisma.companyUsage.findUnique).not.toHaveBeenCalled();
  });
});
