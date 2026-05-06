import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Decimal } from '@prisma/client/runtime/library';
import { TenantPlanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminPlansService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AdminPlansService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** Assign a plan to a tenant with status PENDING_PAYMENT. */
  async assignPlan(tenantId: string, planCode: string, notes?: string) {
    const [tenant, plan] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.billingPlan.findUnique({ where: { code: planCode } }),
    ]);

    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} no encontrado`);
    if (!plan) throw new BadRequestException(`Plan code '${planCode}' no existe`);

    const activePlan = await this.prisma.tenantPlan.findFirst({
      where: { tenantId, status: TenantPlanStatus.ACTIVE },
    });
    if (activePlan) {
      throw new ConflictException(
        'Tenant ya tiene plan activo. Cancelar primero.',
      );
    }

    const tenantPlan = await this.prisma.tenantPlan.create({
      data: { tenantId, planId: plan.id, status: TenantPlanStatus.PENDING_PAYMENT, notes },
      include: { plan: true },
    });

    this.logger.info(`Plan ${planCode} assigned to tenant ${tenantId} (PENDING_PAYMENT)`);
    return { tenantPlan, plan };
  }

  /** Activate a plan: sets status=ACTIVE, timestamps rolling window, creates MonthlyUsage. */
  async activatePlan(tenantPlanId: string) {
    const tenantPlan = await this.prisma.tenantPlan.findUnique({
      where: { id: tenantPlanId },
      include: { plan: true },
    });

    if (!tenantPlan) throw new NotFoundException(`TenantPlan ${tenantPlanId} no encontrado`);
    if (tenantPlan.status === TenantPlanStatus.ACTIVE) {
      throw new ConflictException('El plan ya está activo');
    }
    if (tenantPlan.status === TenantPlanStatus.CANCELED) {
      throw new ConflictException('No se puede activar un plan cancelado');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 days

    const [updated, monthlyUsage] = await this.prisma.$transaction([
      this.prisma.tenantPlan.update({
        where: { id: tenantPlanId },
        data: { status: TenantPlanStatus.ACTIVE, activatedAt: now, expiresAt },
        include: { plan: true },
      }),
      this.prisma.monthlyUsage.create({
        data: {
          tenantId: tenantPlan.tenantId,
          tenantPlanId,
          periodStart: now,
          periodEnd: expiresAt,
          invoicesCount: 0,
        },
      }),
    ]);

    this.logger.info(`TenantPlan ${tenantPlanId} activated; expires ${expiresAt.toISOString()}`);
    return { tenantPlan: updated, monthlyUsage };
  }

  /** Cancel a plan. */
  async cancelPlan(tenantPlanId: string) {
    const tenantPlan = await this.prisma.tenantPlan.findUnique({
      where: { id: tenantPlanId },
    });
    if (!tenantPlan) throw new NotFoundException(`TenantPlan ${tenantPlanId} no encontrado`);

    const updated = await this.prisma.tenantPlan.update({
      where: { id: tenantPlanId },
      data: { status: TenantPlanStatus.CANCELED },
      include: { plan: true },
    });

    this.logger.info(`TenantPlan ${tenantPlanId} canceled`);
    return { tenantPlan: updated };
  }

  /** List the billing plan catalog. */
  async listPlans() {
    return this.prisma.billingPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /** List TenantPlan history for a tenant. */
  async getTenantPlanHistory(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} no encontrado`);

    return this.prisma.tenantPlan.findMany({
      where: { tenantId },
      include: { plan: true, monthlyUsage: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Global billing dashboard metrics. */
  async getDashboard() {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      totalActivePlans,
      totalPendingPayment,
      totalExpired,
      activePlansWithRevenue,
      usageNearLimit,
      expiringSoon,
    ] = await Promise.all([
      this.prisma.tenantPlan.count({ where: { status: TenantPlanStatus.ACTIVE, expiresAt: { gt: now } } }),
      this.prisma.tenantPlan.count({ where: { status: TenantPlanStatus.PENDING_PAYMENT } }),
      this.prisma.tenantPlan.count({ where: { status: TenantPlanStatus.EXPIRED } }),
      // Revenue: sum monthlyFee of active plans
      this.prisma.tenantPlan.findMany({
        where: { status: TenantPlanStatus.ACTIVE, expiresAt: { gt: now } },
        include: { plan: true },
      }),
      // Tenants near limit: usage > 80%
      this.prisma.monthlyUsage.findMany({
        where: { tenantPlan: { status: TenantPlanStatus.ACTIVE, expiresAt: { gt: now } } },
        include: { tenant: true, tenantPlan: { include: { plan: true } } },
      }),
      // Expiring soon: expires in < 7 days
      this.prisma.tenantPlan.findMany({
        where: {
          status: TenantPlanStatus.ACTIVE,
          expiresAt: { gt: now, lt: sevenDaysFromNow },
        },
        include: { tenant: true, plan: true },
      }),
    ]);

    const expectedMonthlyRevenue = activePlansWithRevenue.reduce(
      (sum, tp) => sum.add(tp.plan.monthlyFee),
      new Decimal(0),
    );

    const tenantsNearLimit = usageNearLimit
      .filter((u) => {
        const limit = u.tenantPlan.plan.includedInvoices;
        return limit > 0 && (u.invoicesCount / limit) > 0.8;
      })
      .map((u) => ({
        tenantId: u.tenantId,
        name: u.tenant.name,
        percentage: Math.round((u.invoicesCount / u.tenantPlan.plan.includedInvoices) * 100),
        planCode: u.tenantPlan.plan.code,
      }));

    const expiringSoonList = expiringSoon.map((tp) => {
      const daysLeft = Math.ceil((tp.expiresAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      return {
        tenantId: tp.tenantId,
        name: tp.tenant.name,
        planCode: tp.plan.code,
        expiresAt: tp.expiresAt,
        daysLeft,
      };
    });

    return {
      totalActivePlans,
      totalPendingPayment,
      totalExpired,
      expectedMonthlyRevenue,
      tenantsNearLimit,
      expiringSoon: expiringSoonList,
    };
  }
}
