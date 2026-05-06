import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminPlansService } from './admin-plans.service';
import { makeTestLogger } from '../common/logger/test-logger';
import { TenantPlanStatus } from '@prisma/client';

const PLAN = {
  id: 'plan-id-1', code: 'TIER_1', name: 'Tier 1', monthlyFee: 60,
  includedInvoices: 1500, isActive: true, sortOrder: 1, description: null,
  createdAt: new Date(), updatedAt: new Date(),
};

const TENANT = { id: 'tenant-1', name: 'Acme Corp', email: 'a@b.com' };

const NOW = new Date('2026-05-06T12:00:00.000Z');

function makePrisma() {
  return {
    tenant: { findUnique: jest.fn() },
    billingPlan: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([PLAN]),
    },
    tenantPlan: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    monthlyUsage: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new AdminPlansService(prisma as any, makeTestLogger());
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

  // ── assignPlan ──────────────────────────────────────────────────────────────

  it('assignPlan creates TenantPlan with PENDING_PAYMENT', async () => {
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.billingPlan.findUnique.mockResolvedValue(PLAN);
    prisma.tenantPlan.create.mockResolvedValue({
      id: 'tp-1', tenantId: 'tenant-1', planId: 'plan-id-1',
      status: TenantPlanStatus.PENDING_PAYMENT, plan: PLAN,
    });

    const result = await service.assignPlan('tenant-1', 'TIER_1');
    expect(prisma.tenantPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TenantPlanStatus.PENDING_PAYMENT }),
      }),
    );
    expect(result.plan).toBe(PLAN);
  });

  it('assignPlan throws 404 when tenant not found', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.billingPlan.findUnique.mockResolvedValue(PLAN);
    await expect(service.assignPlan('bad', 'TIER_1')).rejects.toThrow(NotFoundException);
  });

  it('assignPlan throws 400 when plan code not found', async () => {
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.billingPlan.findUnique.mockResolvedValue(null);
    await expect(service.assignPlan('tenant-1', 'INVALID')).rejects.toThrow(BadRequestException);
  });

  it('assignPlan throws 409 when tenant already has active plan', async () => {
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.billingPlan.findUnique.mockResolvedValue(PLAN);
    prisma.tenantPlan.findFirst.mockResolvedValue({ id: 'existing', status: TenantPlanStatus.ACTIVE });
    await expect(service.assignPlan('tenant-1', 'TIER_1')).rejects.toThrow(ConflictException);
  });

  // ── activatePlan ────────────────────────────────────────────────────────────

  it('activatePlan sets ACTIVE + creates MonthlyUsage in a transaction', async () => {
    const tp = { id: 'tp-1', tenantId: 'tenant-1', planId: 'plan-id-1', status: TenantPlanStatus.PENDING_PAYMENT, plan: PLAN };
    prisma.tenantPlan.findUnique.mockResolvedValue(tp);
    prisma.tenantPlan.update.mockResolvedValue({ ...tp, status: TenantPlanStatus.ACTIVE, activatedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * 86400000) });
    prisma.monthlyUsage.create.mockResolvedValue({ id: 'mu-1', invoicesCount: 0 });

    const result = await service.activatePlan('tp-1');
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.monthlyUsage).toBeDefined();
  });

  it('activatePlan throws 404 when TenantPlan not found', async () => {
    prisma.tenantPlan.findUnique.mockResolvedValue(null);
    await expect(service.activatePlan('bad')).rejects.toThrow(NotFoundException);
  });

  it('activatePlan throws 409 when plan is already ACTIVE', async () => {
    prisma.tenantPlan.findUnique.mockResolvedValue({ id: 'tp-1', status: TenantPlanStatus.ACTIVE, plan: PLAN });
    await expect(service.activatePlan('tp-1')).rejects.toThrow(ConflictException);
  });

  // ── cancelPlan ──────────────────────────────────────────────────────────────

  it('cancelPlan sets status to CANCELED', async () => {
    const tp = { id: 'tp-1', status: TenantPlanStatus.ACTIVE };
    prisma.tenantPlan.findUnique.mockResolvedValue(tp);
    prisma.tenantPlan.update.mockResolvedValue({ ...tp, status: TenantPlanStatus.CANCELED, plan: PLAN });

    const result = await service.cancelPlan('tp-1');
    expect(result.tenantPlan.status).toBe(TenantPlanStatus.CANCELED);
  });

  it('cancelPlan throws 404 when TenantPlan not found', async () => {
    prisma.tenantPlan.findUnique.mockResolvedValue(null);
    await expect(service.cancelPlan('bad')).rejects.toThrow(NotFoundException);
  });

  // ── listPlans ───────────────────────────────────────────────────────────────

  it('listPlans returns all active plans ordered by sortOrder', async () => {
    prisma.billingPlan.findMany.mockResolvedValue([PLAN]);
    const result = await service.listPlans();
    expect(result).toHaveLength(1);
    expect(prisma.billingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    );
  });

  // ── getTenantPlanHistory ────────────────────────────────────────────────────

  it('getTenantPlanHistory throws 404 when tenant not found', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.getTenantPlanHistory('bad')).rejects.toThrow(NotFoundException);
  });

  it('getTenantPlanHistory returns plan list for tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.tenantPlan.findMany.mockResolvedValue([{ id: 'tp-1', plan: PLAN }]);
    const result = await service.getTenantPlanHistory('tenant-1');
    expect(result).toHaveLength(1);
  });

  // ── getDashboard ────────────────────────────────────────────────────────────

  it('getDashboard returns aggregated billing metrics', async () => {
    prisma.tenantPlan.count.mockResolvedValue(5);
    prisma.tenantPlan.findMany
      .mockResolvedValueOnce([]) // activePlansWithRevenue
      .mockResolvedValueOnce([]); // expiringSoon
    prisma.monthlyUsage.findMany.mockResolvedValue([]); // usageNearLimit

    const result = await service.getDashboard();
    expect(result).toHaveProperty('totalActivePlans');
    expect(result).toHaveProperty('expectedMonthlyRevenue');
    expect(result).toHaveProperty('tenantsNearLimit');
    expect(result).toHaveProperty('expiringSoon');
  });
});
