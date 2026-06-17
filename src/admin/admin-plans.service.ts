import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CompanyPlanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { calculateMonthlyCharge, PricingRange, PRICING_RANGES } from '../billing/pricing';

@Injectable()
export class AdminPlansService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AdminPlansService.name)
    private readonly logger: PinoLogger,
  ) {}

  /** List the per-emission billing plan catalog (with their pricing tiers). */
  async listPlans() {
    return this.prisma.billingPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { pricingTiers: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /**
   * Billing-v2 dashboard: company-level projected revenue using the REAL formula
   * (per company: US$60 + accepted×range price, min 500). Companies whose current
   * volume lands in the quote-only range are reported separately (total unknown).
   */
  async getDashboard() {
    const now = new Date();

    const activePlans = await this.prisma.companyPlan.findMany({
      where: { status: CompanyPlanStatus.ACTIVE, cycleEndDate: { gt: now } },
      include: { company: true, plan: { include: { pricingTiers: true } } },
    });

    let expectedMonthlyRevenue = 0;
    let companiesRequiringQuote = 0;
    const companies: Array<{
      companyId: string;
      name: string;
      planCode: string;
      acceptedCount: number;
      total: number | null;
      requiresQuote: boolean;
    }> = [];

    for (const cp of activePlans) {
      const usage = await this.prisma.companyUsage.findUnique({
        where: {
          companyId_cycleStartDate: {
            companyId: cp.companyId,
            cycleStartDate: cp.cycleStartDate,
          },
        },
      });
      const acceptedCount = usage?.acceptedCount ?? 0;
      const charge = calculateMonthlyCharge(
        acceptedCount,
        this.toPricingRanges(cp.plan.pricingTiers),
      );

      if (charge.requiresQuote || charge.total === null) {
        companiesRequiringQuote++;
      } else {
        expectedMonthlyRevenue += charge.total;
      }

      companies.push({
        companyId: cp.companyId,
        name: cp.company.businessName,
        planCode: cp.planCode,
        acceptedCount,
        total: charge.total,
        requiresQuote: charge.requiresQuote,
      });
    }

    return {
      totalActivePlans: activePlans.length,
      expectedMonthlyRevenue: Math.round(expectedMonthlyRevenue * 100) / 100,
      companiesRequiringQuote,
      companies,
    };
  }

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
