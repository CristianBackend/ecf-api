import { UsageService } from './usage.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

function makeCompany(dgiiEnv: DgiiEnvironment = DgiiEnvironment.PROD) {
  return { id: 'company-1', dgiiEnv };
}

function makeCompanyPlan(overrides: Partial<any> = {}) {
  return {
    companyId: 'company-1',
    planCode: 'TIER_1',
    cycleStartDate: new Date('2026-05-01T00:00:00Z'),
    cycleEndDate: new Date('2026-06-01T00:00:00Z'),
    status: CompanyPlanStatus.ACTIVE,
    plan: { includedInvoices: 100 },
    ...overrides,
  };
}

// Atomic counter updates now use $queryRaw / $executeRaw, so the mock exposes them.
function makePrisma(overrides: Record<string, any> = {}) {
  return {
    company: { findUnique: jest.fn() },
    companyPlan: { findUnique: jest.fn(), update: jest.fn() },
    companyUsage: { findUnique: jest.fn() },
    invoice: { updateMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function makeNotifications() {
  return { evaluateThresholds: jest.fn().mockResolvedValue(undefined) };
}

function makeLogger() {
  return { info: jest.fn(), error: jest.fn() };
}

function buildService(prisma: any) {
  const notifications = makeNotifications();
  const service = new UsageService(prisma as any, notifications as any, makeLogger() as any);
  return { service, notifications };
}

describe('UsageService.incrementUsage', () => {
  it('returns early when company not found', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('skips usage tracking in DEV environment', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany(DgiiEnvironment.DEV));
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns early when company has no plan', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('consumes BASE quota with a single atomic update when below base/quota', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    // Base UPDATE ... RETURNING applied (1 row).
    prisma.$queryRaw.mockResolvedValueOnce([{ base_used: 6, topup_used: 0, total_quota: 100 }]);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the base branch
    expect(prisma.$executeRaw).not.toHaveBeenCalled(); // no topup accounting
    expect(prisma.companyPlan.update).not.toHaveBeenCalled(); // ceiling not reached
  });

  it('falls back to the TOPUP pool atomically when base is full', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // base branch: no room
      .mockResolvedValueOnce([{ base_used: 100, topup_used: 1, total_quota: 600 }]); // topup branch applied
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // FIFO topup_purchases accounting
  });

  it('marks plan EXHAUSTED when the consumption hits the ceiling', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.$queryRaw.mockResolvedValueOnce([{ base_used: 100, topup_used: 0, total_quota: 100 }]);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');

    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CompanyPlanStatus.EXHAUSTED } }),
    );
  });

  it('THROWS (blocks emission) when quota is exhausted — no row updated', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // base: no room
      .mockResolvedValueOnce([]); // topup: no room
    prisma.companyUsage.findUnique.mockResolvedValue({ baseUsed: 100, topupUsed: 0, totalQuota: 100 });
    const { service } = buildService(prisma);

    await expect(service.incrementUsage('company-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CompanyPlanStatus.EXHAUSTED } }),
    );
  });

  it('THROWS a hard error when the usage row is missing (data inconsistency)', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.companyUsage.findUnique.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await expect(service.incrementUsage('company-1')).rejects.toThrow(/row missing/);
  });
});

describe('UsageService.revertUsage (idempotent refund)', () => {
  it('refunds once when it wins the usageReverted claim', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 }); // claim won
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.$queryRaw.mockResolvedValueOnce([]); // no topup → base decrement branch
    const { service } = buildService(prisma);

    await service.revertUsage('inv-1', 'company-1');

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv-1', usageReverted: false } }),
    );
    expect(prisma.company.findUnique).toHaveBeenCalled(); // decrement ran
    expect(prisma.$executeRaw).toHaveBeenCalled(); // base decrement
  });

  it('does NOT double-refund when already reverted (claim lost)', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 }); // already reverted
    const { service } = buildService(prisma);

    await service.revertUsage('inv-1', 'company-1');

    expect(prisma.company.findUnique).not.toHaveBeenCalled(); // decrement skipped
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
