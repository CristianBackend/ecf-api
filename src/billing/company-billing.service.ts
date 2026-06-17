import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';
import { ActorContext } from '../common/decorators/actor.decorator';

@Injectable()
export class CompanyBillingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(CompanyBillingService.name)
    private readonly logger: PinoLogger,
  ) {}

  async assignPlan(
    companyId: string,
    planCode: string,
    tenantId: string,
    actorCtx?: ActorContext,
  ) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const plan = await this.prisma.billingPlan.findUnique({ where: { code: planCode } });
    if (!plan || !plan.isActive) throw new NotFoundException(`Plan '${planCode}' no encontrado`);

    const now = new Date();
    const cycleEndDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const companyPlan = await this.prisma.companyPlan.upsert({
      where: { companyId },
      update: {
        planCode,
        cycleStartDate: now,
        cycleEndDate,
        status: CompanyPlanStatus.ACTIVE,
      },
      create: {
        companyId,
        planCode,
        cycleStartDate: now,
        cycleEndDate,
        autoRenew: true,
        status: CompanyPlanStatus.ACTIVE,
      },
    });

    await this.prisma.companyUsage.upsert({
      where: {
        companyId_cycleStartDate: { companyId, cycleStartDate: now },
      },
      update: {},
      create: {
        companyId,
        cycleStartDate: now,
        baseUsed: 0,
        topupUsed: 0,
        totalQuota: plan.includedInvoices,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        entityType: 'company',
        entityId: companyId,
        action: 'plan_assigned',
        actor: actorCtx?.actor ?? 'api',
        ipAddress: actorCtx?.ipAddress ?? null,
        metadata: { companyId, planCode },
      },
    });

    return companyPlan;
  }

  /**
   * Checks whether a company is allowed to emit a new invoice.
   * Returns `fallback: true` when the company has no CompanyPlan — the
   * caller (ActivePlanGuard) falls through to the TenantPlan check.
   */
  async canEmitInvoice(
    companyId: string,
    tenantId: string,
  ): Promise<{ allowed: boolean; reason?: string; fallback?: boolean }> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) return { allowed: false, reason: 'Empresa no encontrada' };

    // DEV environment — always allow without plan check
    if (company.dgiiEnv === DgiiEnvironment.DEV) return { allowed: true };

    const companyPlan = await this.prisma.companyPlan.findUnique({
      where: { companyId },
    });

    // No company plan — fall back to tenant-level billing
    if (!companyPlan) return { allowed: true, fallback: true };

    if (companyPlan.status === CompanyPlanStatus.EXPIRED) {
      return { allowed: false, reason: 'Plan vencido' };
    }
    if (companyPlan.status === CompanyPlanStatus.CANCELLED) {
      return { allowed: false, reason: 'Plan cancelado' };
    }
    if (companyPlan.status === CompanyPlanStatus.EXHAUSTED) {
      return { allowed: false, reason: 'Cuota agotada — adquiere un topup para continuar' };
    }

    if (companyPlan.cycleEndDate < new Date()) {
      return { allowed: false, reason: 'Plan vencido' };
    }

    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });

    if (!usage) return { allowed: true };

    if (usage.baseUsed + usage.topupUsed >= usage.totalQuota) {
      return { allowed: false, reason: 'Cuota agotada — adquiere un topup para continuar' };
    }

    return { allowed: true };
  }

  async getUsage(companyId: string, tenantId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const companyPlan = await this.prisma.companyPlan.findUnique({
      where: { companyId },
      include: { plan: true },
    });

    if (!companyPlan) return { hasActivePlan: false };

    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });

    const now = new Date();
    const daysRemaining = Math.max(
      0,
      Math.ceil(
        (companyPlan.cycleEndDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      ),
    );

    const activeTopups = await this.prisma.topupPurchase.findMany({
      where: {
        companyId,
        cycleStartDate: companyPlan.cycleStartDate,
        cycleEndDate: { gt: now },
      },
      include: { topupPack: true },
    });

    const baseUsed = usage?.baseUsed ?? 0;
    const topupUsed = usage?.topupUsed ?? 0;
    const totalQuota = usage?.totalQuota ?? companyPlan.plan.includedInvoices;

    return {
      hasActivePlan: true,
      plan: {
        code: companyPlan.planCode,
        name: companyPlan.plan.name,
        includedInvoices: companyPlan.plan.includedInvoices,
        monthlyFee: companyPlan.plan.monthlyFee,
      },
      cycle: {
        startDate: companyPlan.cycleStartDate,
        endDate: companyPlan.cycleEndDate,
        daysRemaining,
        autoRenew: companyPlan.autoRenew,
        status: companyPlan.status,
      },
      usage: {
        baseUsed,
        topupUsed,
        totalUsed: baseUsed + topupUsed,
        totalQuota,
        remaining: Math.max(0, totalQuota - baseUsed - topupUsed),
      },
      activeTopups: activeTopups.map((t) => ({
        id: t.id,
        topupPackCode: t.topupPackCode,
        invoiceCount: t.topupPack.invoiceCount,
        invoicesUsed: t.invoicesUsed,
        cycleEndDate: t.cycleEndDate,
      })),
    };
  }

  async purchaseTopup(companyId: string, topupPackCode: string, tenantId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const companyPlan = await this.prisma.companyPlan.findUnique({
      where: { companyId },
    });
    if (!companyPlan) throw new NotFoundException('Empresa sin plan activo');

    const topupPack = await this.prisma.topupPack.findUnique({
      where: { code: topupPackCode },
    });
    if (!topupPack || !topupPack.isActive) {
      throw new NotFoundException(`Topup pack '${topupPackCode}' no encontrado`);
    }

    const purchase = await this.prisma.topupPurchase.create({
      data: {
        companyId,
        topupPackCode,
        cycleStartDate: companyPlan.cycleStartDate,
        cycleEndDate: companyPlan.cycleEndDate,
        invoicesUsed: 0,
      },
    });

    // Increase quota and reset exhausted state
    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });

    if (usage) {
      await this.prisma.companyUsage.update({
        where: {
          companyId_cycleStartDate: {
            companyId,
            cycleStartDate: companyPlan.cycleStartDate,
          },
        },
        data: {
          totalQuota: { increment: topupPack.invoiceCount },
          notified100: false,
        },
      });
    }

    if (companyPlan.status === CompanyPlanStatus.EXHAUSTED) {
      await this.prisma.companyPlan.update({
        where: { companyId },
        data: { status: CompanyPlanStatus.ACTIVE },
      });
    }

    return purchase;
  }

  async getAlerts(companyId: string, tenantId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    return this.prisma.billingAlert.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markAlertRead(companyId: string, alertId: string, tenantId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const alert = await this.prisma.billingAlert.findFirst({
      where: { id: alertId, companyId },
    });
    if (!alert) throw new NotFoundException('Alerta no encontrada');

    return this.prisma.billingAlert.update({
      where: { id: alertId },
      data: { isRead: true },
    });
  }
}
