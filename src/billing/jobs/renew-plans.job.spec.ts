import { RenewPlansJob } from './renew-plans.job';
import { CompanyPlanStatus } from '@prisma/client';

const NOW = new Date('2026-06-01T00:00:00Z');

function makeExpiredPlan(overrides: Partial<any> = {}) {
  return {
    id: 'plan-1',
    companyId: 'company-1',
    cycleEndDate: new Date('2026-05-31T00:00:00Z'),
    status: CompanyPlanStatus.ACTIVE,
    autoRenew: true,
    plan: { includedInvoices: 100 },
    ...overrides,
  };
}

function makePrisma() {
  return {
    companyPlan: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    companyUsage: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  };
}

function makeLock() {
  return {
    withLock: jest.fn((key: string, ttl: number, fn: () => Promise<void>) => fn()),
  };
}

function makeLogger() {
  return { info: jest.fn(), error: jest.fn() };
}

function buildJob(prisma: any) {
  return new RenewPlansJob(prisma as any, makeLock() as any, makeLogger() as any);
}

describe('RenewPlansJob.renewExpiredPlans', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('does nothing when no expired plans', async () => {
    const prisma = makePrisma();
    prisma.companyPlan.findMany.mockResolvedValue([]);
    const job = buildJob(prisma);

    await job.renewExpiredPlans();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('auto-renews plan and creates new usage record when autoRenew=true', async () => {
    const plan = makeExpiredPlan({ autoRenew: true });
    const prisma = makePrisma();
    prisma.companyPlan.findMany.mockResolvedValue([plan]);
    const job = buildJob(prisma);

    await job.renewExpiredPlans();

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('marks plan EXPIRED when autoRenew=false', async () => {
    const plan = makeExpiredPlan({ autoRenew: false });
    const prisma = makePrisma();
    prisma.companyPlan.findMany.mockResolvedValue([plan]);
    const job = buildJob(prisma);

    await job.renewExpiredPlans();

    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: plan.id },
        data: { status: CompanyPlanStatus.EXPIRED },
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('continues processing other plans when one fails', async () => {
    const plan1 = makeExpiredPlan({ id: 'plan-1', companyId: 'company-1' });
    const plan2 = makeExpiredPlan({ id: 'plan-2', companyId: 'company-2', autoRenew: false });
    const prisma = makePrisma();
    prisma.companyPlan.findMany.mockResolvedValue([plan1, plan2]);
    prisma.$transaction.mockRejectedValueOnce(new Error('DB error'));
    const job = buildJob(prisma);

    await expect(job.renewExpiredPlans()).resolves.not.toThrow();
    // plan2 should still be processed
    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan-2' } }),
    );
  });
});
