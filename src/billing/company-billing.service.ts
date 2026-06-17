import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';
import {
  calculateMonthlyCharge,
  PricingRange,
  PRICING_RANGES,
} from './pricing';

@Injectable()
export class CompanyBillingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(CompanyBillingService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Assign a per-emission plan to a company (manual). Opens a 30-day cycle and a
   * fresh accepted-emissions counter. No quota — emission is never blocked by
   * volume in billing-v2.
   */
  async assignPlan(companyId: string, planCode: string, tenantId: string) {
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
      where: { companyId_cycleStartDate: { companyId, cycleStartDate: now } },
      update: {},
      create: { companyId, cycleStartDate: now, acceptedCount: 0 },
    });

    return companyPlan;
  }

  /**
   * Billing-v2 emission gate: a company must have an ACTIVE, non-expired plan so
   * we know its rate — but volume is NEVER blocked (post-pay). DEV companies are
   * always allowed. Returns `{ allowed, reason? }`.
   */
  async canEmitInvoice(
    companyId: string,
    tenantId: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) return { allowed: false, reason: 'Empresa no encontrada' };

    // DEV sandbox — always allowed, no plan required.
    if (company.dgiiEnv === DgiiEnvironment.DEV) return { allowed: true };

    const companyPlan = await this.prisma.companyPlan.findUnique({ where: { companyId } });
    if (!companyPlan) {
      return { allowed: false, reason: 'Empresa sin plan asignado — asigna un plan para conocer su tarifa' };
    }
    if (companyPlan.status === CompanyPlanStatus.CANCELLED) {
      return { allowed: false, reason: 'Plan cancelado' };
    }
    if (companyPlan.status === CompanyPlanStatus.EXPIRED || companyPlan.cycleEndDate < new Date()) {
      return { allowed: false, reason: 'Plan vencido' };
    }
    // ACTIVE plan → allowed regardless of how many emissions this cycle.
    return { allowed: true };
  }

  /** Usage summary for a company (billing-v2: accepted-count + cycle, no quota/topups). */
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
        companyId_cycleStartDate: { companyId, cycleStartDate: companyPlan.cycleStartDate },
      },
    });

    const now = new Date();
    const daysRemaining = Math.max(
      0,
      Math.ceil((companyPlan.cycleEndDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );

    return {
      hasActivePlan: true,
      plan: {
        code: companyPlan.planCode,
        name: companyPlan.plan.name,
        type: companyPlan.plan.type,
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
        acceptedCount: usage?.acceptedCount ?? 0,
      },
    };
  }

  /**
   * Billing-v2: current-month projected charge for the active cycle. Read-only —
   * MEASURES and CALCULATES, never charges. Returns the flat-by-range breakdown
   * (or requiresQuote / total:null for the quote-only range).
   */
  async getCurrentMonthBilling(companyId: string, tenantId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const companyPlan = await this.prisma.companyPlan.findUnique({
      where: { companyId },
      include: { plan: { include: { pricingTiers: true } } },
    });
    if (!companyPlan) return { hasActivePlan: false };

    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: { companyId, cycleStartDate: companyPlan.cycleStartDate },
      },
    });
    const acceptedCount = usage?.acceptedCount ?? 0;

    const ranges = this.toPricingRanges(companyPlan.plan.pricingTiers);
    const charge = calculateMonthlyCharge(acceptedCount, ranges);

    return {
      hasActivePlan: true,
      companyId,
      plan: { code: companyPlan.planCode, name: companyPlan.plan.name },
      cycle: {
        startDate: companyPlan.cycleStartDate,
        endDate: companyPlan.cycleEndDate,
      },
      charge,
    };
  }

  /**
   * Map the plan's configurable PricingTier rows to the pure-engine PricingRange
   * shape. Falls back to the canonical {@link PRICING_RANGES} when the plan has
   * no tiers configured.
   */
  private toPricingRanges(
    tiers: Array<{
      fromQty: number;
      toQty: number | null;
      pricePerEmission: unknown;
      requiresQuote: boolean;
      sortOrder: number;
    }>,
  ): PricingRange[] {
    if (!tiers || tiers.length === 0) return PRICING_RANGES;
    return [...tiers]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.fromQty - b.fromQty)
      .map((t) => ({
        fromQty: t.fromQty,
        toQty: t.toQty,
        pricePerEmission:
          t.pricePerEmission === null || t.pricePerEmission === undefined
            ? null
            : Number(t.pricePerEmission),
        requiresQuote: t.requiresQuote,
      }));
  }
}
