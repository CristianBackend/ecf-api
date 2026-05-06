import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma, TenantPlanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(BillingService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** Returns the tenant's currently ACTIVE and non-expired TenantPlan, or null. */
  async getActivePlan(tenantId: string) {
    return this.prisma.tenantPlan.findFirst({
      where: {
        tenantId,
        status: TenantPlanStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      include: { plan: true },
    });
  }

  /**
   * Returns invoice usage metrics for the current billing period, or null if
   * the tenant has no active plan.
   */
  async getCurrentUsage(tenantId: string) {
    const activePlan = await this.getActivePlan(tenantId);
    if (!activePlan) return null;

    const usage = await this.prisma.monthlyUsage.findUnique({
      where: { tenantPlanId: activePlan.id },
    });

    const count = usage?.invoicesCount ?? 0;
    const limit = activePlan.plan.includedInvoices;
    const percentage = limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;

    return {
      count,
      limit,
      percentage,
      plan: activePlan.plan,
      periodEnd: activePlan.expiresAt!,
    };
  }

  /**
   * Checks whether the tenant is allowed to emit a new invoice.
   * Returns `{ allowed: true }` or `{ allowed: false, reason }`.
   */
  async canEmitInvoice(tenantId: string): Promise<{ allowed: boolean; reason?: string }> {
    const activePlan = await this.getActivePlan(tenantId);
    if (!activePlan) {
      return { allowed: false, reason: 'Sin plan activo' };
    }

    const usage = await this.prisma.monthlyUsage.findUnique({
      where: { tenantPlanId: activePlan.id },
    });

    const count = usage?.invoicesCount ?? 0;
    if (count >= activePlan.plan.includedInvoices) {
      return { allowed: false, reason: 'Plan excedido' };
    }

    return { allowed: true };
  }

  /**
   * Atomically increments the invoice counter for the active plan period.
   * Accepts an optional Prisma transaction client for atomicity with the
   * invoice creation — if the outer transaction rolls back, the increment
   * rolls back too.
   *
   * Uses `{ increment: 1 }` (no read-then-update) to handle concurrent requests.
   */
  async incrementInvoiceCount(
    tenantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    const activePlan = await db.tenantPlan.findFirst({
      where: {
        tenantId,
        status: TenantPlanStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });
    if (!activePlan) return;

    await db.monthlyUsage.upsert({
      where: { tenantPlanId: activePlan.id },
      update: { invoicesCount: { increment: 1 } },
      create: {
        tenantId,
        tenantPlanId: activePlan.id,
        periodStart: activePlan.activatedAt ?? new Date(),
        periodEnd: activePlan.expiresAt ?? new Date(),
        invoicesCount: 1,
      },
    });
  }

  /**
   * Marks all ACTIVE plans whose expiresAt < now as EXPIRED.
   * Called by the billing scheduler every hour.
   * Returns the number of plans expired.
   */
  async expireStalePlans(): Promise<number> {
    const result = await this.prisma.tenantPlan.updateMany({
      where: {
        status: TenantPlanStatus.ACTIVE,
        expiresAt: { lt: new Date() },
      },
      data: { status: TenantPlanStatus.EXPIRED },
    });

    if (result.count > 0) {
      this.logger.info(`Expired ${result.count} stale plan(s)`);
    }

    return result.count;
  }
}
