import { BillingService } from './billing.service';
import { makeTestLogger } from '../common/logger/test-logger';
import { TenantPlanStatus } from '@prisma/client';

const NOW = new Date('2026-05-06T12:00:00.000Z');
const FUTURE = new Date('2026-06-05T12:00:00.000Z'); // +30 days
const PAST = new Date('2026-05-05T11:00:00.000Z');   // 1 hour ago

const PLAN = {
  id: 'plan-1',
  code: 'TIER_1',
  name: 'Tier 1',
  monthlyFee: 60,
  includedInvoices: 1500,
  isActive: true,
  sortOrder: 1,
  description: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const ACTIVE_TENANT_PLAN = {
  id: 'tp-1',
  tenantId: 'tenant-1',
  planId: 'plan-1',
  status: TenantPlanStatus.ACTIVE,
  activatedAt: PAST,
  expiresAt: FUTURE,
  notes: null,
  createdAt: PAST,
  updatedAt: PAST,
  plan: PLAN,
};

function makePrisma() {
  return {
    tenantPlan: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    monthlyUsage: {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('BillingService', () => {
  let service: BillingService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = makePrisma();
    service = new BillingService(prisma as any, makeTestLogger());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── getActivePlan ───────────────────────────────────────────────────────────

  it('getActivePlan returns active plan when present', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    const result = await service.getActivePlan('tenant-1');
    expect(result).toBe(ACTIVE_TENANT_PLAN);
    expect(prisma.tenantPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: TenantPlanStatus.ACTIVE }) }),
    );
  });

  it('getActivePlan returns null when no active plan', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(null);
    const result = await service.getActivePlan('tenant-1');
    expect(result).toBeNull();
  });

  // ── getCurrentUsage ─────────────────────────────────────────────────────────

  it('getCurrentUsage returns null when no active plan', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(null);
    const result = await service.getCurrentUsage('tenant-1');
    expect(result).toBeNull();
  });

  it('getCurrentUsage returns usage metrics with existing MonthlyUsage', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue({ invoicesCount: 300 });
    const result = await service.getCurrentUsage('tenant-1');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(300);
    expect(result!.limit).toBe(1500);
    expect(result!.percentage).toBe(20);
    expect(result!.plan).toBe(PLAN);
    expect(result!.periodEnd).toBe(FUTURE);
  });

  it('getCurrentUsage treats missing MonthlyUsage as count=0', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue(null);
    const result = await service.getCurrentUsage('tenant-1');
    expect(result!.count).toBe(0);
    expect(result!.percentage).toBe(0);
  });

  // ── canEmitInvoice ──────────────────────────────────────────────────────────

  it('canEmitInvoice allows when plan active and under limit', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue({ invoicesCount: 100 });
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: true });
  });

  it('canEmitInvoice denies when no active plan', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(null);
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: false, reason: 'Sin plan activo' });
  });

  it('canEmitInvoice denies when plan limit exactly reached', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue({ invoicesCount: 1500 }); // exactly at limit
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: false, reason: 'Plan excedido' });
  });

  it('canEmitInvoice denies when plan limit exceeded', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue({ invoicesCount: 1501 });
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: false, reason: 'Plan excedido' });
  });

  it('canEmitInvoice denies expired plan', async () => {
    // getActivePlan queries with expiresAt > now — if plan is expired, findFirst returns null
    prisma.tenantPlan.findFirst.mockResolvedValue(null);
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: false, reason: 'Sin plan activo' });
  });

  it('canEmitInvoice allows when usage is null (plan freshly created, 0 invoices)', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    prisma.monthlyUsage.findUnique.mockResolvedValue(null);
    const result = await service.canEmitInvoice('tenant-1');
    expect(result).toEqual({ allowed: true });
  });

  // ── incrementInvoiceCount ───────────────────────────────────────────────────

  it('incrementInvoiceCount upserts MonthlyUsage atomically', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(ACTIVE_TENANT_PLAN);
    await service.incrementInvoiceCount('tenant-1');
    expect(prisma.monthlyUsage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantPlanId: 'tp-1' },
        update: { invoicesCount: { increment: 1 } },
      }),
    );
  });

  it('incrementInvoiceCount is a no-op when tenant has no active plan', async () => {
    prisma.tenantPlan.findFirst.mockResolvedValue(null);
    await service.incrementInvoiceCount('tenant-1');
    expect(prisma.monthlyUsage.upsert).not.toHaveBeenCalled();
  });

  it('incrementInvoiceCount accepts a transaction client', async () => {
    const tx = {
      tenantPlan: { findFirst: jest.fn().mockResolvedValue(ACTIVE_TENANT_PLAN) },
      monthlyUsage: { upsert: jest.fn().mockResolvedValue({}) },
    };
    await service.incrementInvoiceCount('tenant-1', tx as any);
    expect(tx.monthlyUsage.upsert).toHaveBeenCalled();
    expect(prisma.monthlyUsage.upsert).not.toHaveBeenCalled(); // main prisma not used
  });

  // ── expireStalePlans ────────────────────────────────────────────────────────

  it('expireStalePlans updates expired plans and returns count', async () => {
    prisma.tenantPlan.updateMany.mockResolvedValue({ count: 3 });
    const count = await service.expireStalePlans();
    expect(count).toBe(3);
    expect(prisma.tenantPlan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: TenantPlanStatus.ACTIVE }),
        data: { status: TenantPlanStatus.EXPIRED },
      }),
    );
  });

  it('expireStalePlans returns 0 when nothing expired', async () => {
    prisma.tenantPlan.updateMany.mockResolvedValue({ count: 0 });
    const count = await service.expireStalePlans();
    expect(count).toBe(0);
  });
});
