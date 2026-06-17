import { CompanyBillingService } from './company-billing.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';

function makeLogger() {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

function makePrisma(over: Record<string, any> = {}) {
  return {
    company: { findFirst: jest.fn() },
    companyPlan: { findUnique: jest.fn(), upsert: jest.fn() },
    companyUsage: { findUnique: jest.fn(), upsert: jest.fn() },
    billingPlan: { findUnique: jest.fn() },
    ...over,
  };
}

function build(prisma: any) {
  return new CompanyBillingService(prisma as any, makeLogger() as any);
}

const FUTURE = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

describe('CompanyBillingService.canEmitInvoice (billing-v2: plan required, NEVER blocked by volume)', () => {
  it('allows DEV companies without a plan', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.DEV });
    const r = await build(prisma).canEmitInvoice('c1', 't1');
    expect(r.allowed).toBe(true);
    expect(prisma.companyPlan.findUnique).not.toHaveBeenCalled();
  });

  it('denies a CERT/PROD company with NO plan assigned (we must know the rate)', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue(null);
    const r = await build(prisma).canEmitInvoice('c1', 't1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/sin plan asignado/i);
  });

  it('ALLOWS an active plan regardless of how many emissions this cycle (no quota, post-pay)', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue({
      status: CompanyPlanStatus.ACTIVE,
      cycleEndDate: FUTURE,
    });
    const r = await build(prisma).canEmitInvoice('c1', 't1');
    expect(r.allowed).toBe(true);
    // crucially: usage/acceptedCount is never even consulted to gate emission
    expect(prisma.companyUsage.findUnique).not.toHaveBeenCalled();
  });

  it('denies an expired plan (by status or by cycleEndDate in the past)', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue({
      status: CompanyPlanStatus.ACTIVE,
      cycleEndDate: PAST,
    });
    const r = await build(prisma).canEmitInvoice('c1', 't1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/vencido/i);
  });

  it('denies a cancelled plan', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue({
      status: CompanyPlanStatus.CANCELLED,
      cycleEndDate: FUTURE,
    });
    const r = await build(prisma).canEmitInvoice('c1', 't1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cancelado/i);
  });
});

describe('CompanyBillingService.getCurrentMonthBilling (read-only projected charge)', () => {
  it('projects the flat-by-range charge from the cycle accepted-count', async () => {
    const prisma = makePrisma();
    const cycleStartDate = new Date('2026-06-01T00:00:00Z');
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue({
      planCode: 'PER_EMISSION',
      cycleStartDate,
      cycleEndDate: FUTURE,
      plan: { name: 'Pago por Emisión', pricingTiers: [] }, // empty → engine uses canonical ranges
    });
    prisma.companyUsage.findUnique.mockResolvedValue({ acceptedCount: 2000 });

    const r: any = await build(prisma).getCurrentMonthBilling('c1', 't1');

    expect(r.hasActivePlan).toBe(true);
    // 2000 accepted → range 1001–3000 @ 0.04 → 80 emissions + 60 = 140
    expect(r.charge.acceptedCount).toBe(2000);
    expect(r.charge.billedCount).toBe(2000);
    expect(r.charge.total).toBe(140);
    expect(r.charge.requiresQuote).toBe(false);
  });

  it('returns the minimum (500-billed) charge when there are no accepted emissions yet', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue({
      planCode: 'PER_EMISSION',
      cycleStartDate: new Date('2026-06-01T00:00:00Z'),
      cycleEndDate: FUTURE,
      plan: { name: 'Pago por Emisión', pricingTiers: [] },
    });
    prisma.companyUsage.findUnique.mockResolvedValue(null); // no usage row yet → 0 accepted

    const r: any = await build(prisma).getCurrentMonthBilling('c1', 't1');
    expect(r.charge.acceptedCount).toBe(0);
    expect(r.charge.billedCount).toBe(500);
    expect(r.charge.total).toBe(90);
  });

  it('returns hasActivePlan=false when the company has no plan', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.companyPlan.findUnique.mockResolvedValue(null);
    const r: any = await build(prisma).getCurrentMonthBilling('c1', 't1');
    expect(r.hasActivePlan).toBe(false);
  });
});

describe('CompanyBillingService.assignPlan', () => {
  it('upserts an ACTIVE company plan and a zeroed accepted-count usage row', async () => {
    const prisma = makePrisma();
    prisma.company.findFirst.mockResolvedValue({ id: 'c1', dgiiEnv: DgiiEnvironment.PROD });
    prisma.billingPlan.findUnique.mockResolvedValue({ code: 'PER_EMISSION', isActive: true });
    prisma.companyPlan.upsert.mockResolvedValue({ companyId: 'c1', planCode: 'PER_EMISSION' });
    prisma.companyUsage.upsert.mockResolvedValue({});

    await build(prisma).assignPlan('c1', 'PER_EMISSION', 't1');

    expect(prisma.companyPlan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'c1' },
        create: expect.objectContaining({ status: CompanyPlanStatus.ACTIVE, planCode: 'PER_EMISSION' }),
      }),
    );
    expect(prisma.companyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ acceptedCount: 0 }) }),
    );
  });
});
