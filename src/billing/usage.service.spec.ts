import { UsageService } from './usage.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';

function makeCompany(dgiiEnv: DgiiEnvironment = DgiiEnvironment.PROD) {
  return { id: 'company-1', dgiiEnv };
}

function makeCompanyPlan(overrides: Partial<any> = {}) {
  return {
    companyId: 'company-1',
    planCode: 'PER_EMISSION',
    cycleStartDate: new Date('2026-05-01T00:00:00Z'),
    cycleEndDate: new Date('2026-06-01T00:00:00Z'),
    status: CompanyPlanStatus.ACTIVE,
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    company: { findUnique: jest.fn() },
    companyPlan: { findUnique: jest.fn() },
    companyUsage: { upsert: jest.fn().mockResolvedValue({}) },
    invoice: { updateMany: jest.fn() },
    ...overrides,
  };
}

function makeLogger() {
  return { info: jest.fn(), error: jest.fn() };
}

function buildService(prisma: any) {
  return new UsageService(prisma as any, makeLogger() as any);
}

describe('UsageService.countAcceptedEmission (count at acceptance, idempotent)', () => {
  it('counts once when it WINS the usageCounted claim — increments acceptedCount for the cycle', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 }); // claim won
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(makeCompanyPlan());
    const service = buildService(prisma);

    await service.countAcceptedEmission('inv-1', 'company-1');

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1', usageCounted: false },
        data: { usageCounted: true },
      }),
    );
    expect(prisma.companyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyId_cycleStartDate: {
            companyId: 'company-1',
            cycleStartDate: makeCompanyPlan().cycleStartDate,
          },
        },
        update: { acceptedCount: { increment: 1 } },
        create: expect.objectContaining({ acceptedCount: 1 }),
      }),
    );
  });

  it('does NOT double-count when the claim is LOST (already counted / re-poll)', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 }); // already counted
    const service = buildService(prisma);

    await service.countAcceptedEmission('inv-1', 'company-1');

    // claim lost → no metering work at all
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(prisma.companyUsage.upsert).not.toHaveBeenCalled();
  });

  it('does NOT count for DEV companies (claim flipped, but not metered)', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.company.findUnique.mockResolvedValue(makeCompany(DgiiEnvironment.DEV));
    const service = buildService(prisma);

    await service.countAcceptedEmission('inv-1', 'company-1');

    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.companyUsage.upsert).not.toHaveBeenCalled();
  });

  it('does NOT count when the company has no plan assigned', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.company.findUnique.mockResolvedValue(makeCompany());
    prisma.companyPlan.findUnique.mockResolvedValue(null);
    const service = buildService(prisma);

    await service.countAcceptedEmission('inv-1', 'company-1');

    expect(prisma.companyUsage.upsert).not.toHaveBeenCalled();
  });

  it('does NOT count when company not found', async () => {
    const prisma = makePrisma();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.company.findUnique.mockResolvedValue(null);
    const service = buildService(prisma);

    await service.countAcceptedEmission('inv-1', 'company-1');

    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.companyUsage.upsert).not.toHaveBeenCalled();
  });
});
