import { BillingNotificationsService } from './billing-notifications.service';
import { BillingAlertLevel, CompanyPlanStatus } from '@prisma/client';

const CYCLE_START = new Date('2026-05-01T00:00:00Z');
const COMPANY_ID = 'company-1';

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

function makePrisma() {
  return {
    billingAlert: { create: jest.fn().mockResolvedValue({}) },
    companyPlan: { update: jest.fn().mockResolvedValue({}) },
    companyUsage: { update: jest.fn().mockResolvedValue({}) },
  };
}

function makeLogger() {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
}

function buildService(prisma: any) {
  return new BillingNotificationsService(prisma as any, makeLogger() as any);
}

describe('BillingNotificationsService.evaluateThresholds', () => {
  it('does nothing when usage is below 70%', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(COMPANY_ID, CYCLE_START, makeUsage({ baseUsed: 60 }));

    expect(prisma.billingAlert.create).not.toHaveBeenCalled();
    expect(prisma.companyUsage.update).not.toHaveBeenCalled();
  });

  it('creates INFO alert at 70%', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(COMPANY_ID, CYCLE_START, makeUsage({ baseUsed: 70 }));

    expect(prisma.billingAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: BillingAlertLevel.INFO, percentage: 70 }),
      }),
    );
    expect(prisma.companyUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notified70: true }) }),
    );
  });

  it('creates WARNING alert at 85%', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(
      COMPANY_ID,
      CYCLE_START,
      makeUsage({ baseUsed: 85, notified70: true }),
    );

    expect(prisma.billingAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: BillingAlertLevel.WARNING, percentage: 85 }),
      }),
    );
  });

  it('creates CRITICAL alert at 95%', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(
      COMPANY_ID,
      CYCLE_START,
      makeUsage({ baseUsed: 95, notified70: true, notified85: true }),
    );

    expect(prisma.billingAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: BillingAlertLevel.CRITICAL, percentage: 95 }),
      }),
    );
  });

  it('creates BLOCKED alert and marks plan EXHAUSTED at 100%', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(
      COMPANY_ID,
      CYCLE_START,
      makeUsage({
        baseUsed: 100,
        notified70: true,
        notified85: true,
        notified95: true,
      }),
    );

    expect(prisma.billingAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: BillingAlertLevel.BLOCKED, percentage: 100 }),
      }),
    );
    expect(prisma.companyPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CompanyPlanStatus.EXHAUSTED } }),
    );
  });

  it('skips already-notified thresholds', async () => {
    const prisma = makePrisma();
    const svc = buildService(prisma);

    await svc.evaluateThresholds(
      COMPANY_ID,
      CYCLE_START,
      makeUsage({
        baseUsed: 100,
        notified70: true,
        notified85: true,
        notified95: true,
        notified100: true,
      }),
    );

    expect(prisma.billingAlert.create).not.toHaveBeenCalled();
    expect(prisma.companyUsage.update).not.toHaveBeenCalled();
  });
});
