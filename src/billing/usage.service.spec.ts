import { UsageService } from './usage.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';

const NOW = new Date('2026-06-01T00:00:00Z');

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

function makeUsage(overrides: Partial<any> = {}) {
  return {
    baseUsed: 0,
    topupUsed: 0,
    totalQuota: 100,
    notified70: false,
    notified85: false,
    notified95: false,
    notified100: false,
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    company: { findUnique: jest.fn() },
    companyPlan: { findUnique: jest.fn(), update: jest.fn() },
    companyUsage: { findUnique: jest.fn(), update: jest.fn() },
    topupPurchase: { findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
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
  });

  it('skips usage tracking in DEV environment', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany(DgiiEnvironment.DEV));
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
  });

  it('returns early when company has no plan', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.companyUsage.findUnique).not.toHaveBeenCalled();
  });

  it('marks plan EXHAUSTED and returns early when quota already full', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.companyUsage.findUnique.mockResolvedValue(
      makeUsage({ baseUsed: 100, topupUsed: 0, totalQuota: 100 }),
    );
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CompanyPlanStatus.EXHAUSTED } }),
    );
    expect(prisma.companyUsage.update).not.toHaveBeenCalled();
  });

  it('increments baseUsed when below base quota', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.companyUsage.findUnique
      .mockResolvedValueOnce(makeUsage({ baseUsed: 5, topupUsed: 0, totalQuota: 100 }))
      .mockResolvedValueOnce(makeUsage({ baseUsed: 6, topupUsed: 0, totalQuota: 100 }));
    const { service, notifications } = buildService(prisma);

    await service.incrementUsage('company-1');

    expect(prisma.companyUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseUsed: { increment: 1 } } }),
    );
    expect(notifications.evaluateThresholds).toHaveBeenCalled();
  });

  it('consumes oldest topup when base quota is full', async () => {
    const topup = { id: 'topup-1', topupPackCode: 'TOPUP_500', createdAt: new Date() };
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.companyUsage.findUnique
      .mockResolvedValueOnce(makeUsage({ baseUsed: 100, topupUsed: 0, totalQuota: 600 }))
      .mockResolvedValueOnce(makeUsage({ baseUsed: 100, topupUsed: 1, totalQuota: 600 }));
    prisma.topupPurchase.findFirst.mockResolvedValue(topup);
    prisma.$transaction.mockResolvedValue([{}, {}]);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('does not attempt topup increment when no topup exists', async () => {
    const prisma = makePrisma();
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    prisma.companyUsage.findUnique
      .mockResolvedValueOnce(makeUsage({ baseUsed: 100, topupUsed: 0, totalQuota: 100 }));
    prisma.topupPurchase.findFirst.mockResolvedValue(null);
    const { service } = buildService(prisma);

    await service.incrementUsage('company-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
