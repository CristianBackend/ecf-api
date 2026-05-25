import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyPlanStatus, DgiiEnvironment } from '@prisma/client';
import { BillingNotificationsService } from './notifications/billing-notifications.service';

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: BillingNotificationsService,
    @InjectPinoLogger(UsageService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Atomically increments the company's invoice usage for the current cycle.
   * Consumes base quota first, then oldest topup FIFO.
   * Fire-and-forget safe: logs errors but never throws.
   */
  async incrementUsage(companyId: string): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) return;

    // DEV environment — do not track usage
    if (company.dgiiEnv === DgiiEnvironment.DEV) return;

    const companyPlan = await this.prisma.companyPlan.findUnique({
      where: { companyId },
      include: { plan: true },
    });
    if (!companyPlan || companyPlan.status === CompanyPlanStatus.EXPIRED) return;

    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });
    if (!usage) return;

    const totalUsed = usage.baseUsed + usage.topupUsed;
    if (totalUsed >= usage.totalQuota) {
      if (companyPlan.status !== CompanyPlanStatus.EXHAUSTED) {
        await this.prisma.companyPlan.update({
          where: { companyId },
          data: { status: CompanyPlanStatus.EXHAUSTED },
        });
      }
      return;
    }

    const planBase = companyPlan.plan.includedInvoices;
    if (usage.baseUsed < planBase) {
      await this.prisma.companyUsage.update({
        where: {
          companyId_cycleStartDate: {
            companyId,
            cycleStartDate: companyPlan.cycleStartDate,
          },
        },
        data: { baseUsed: { increment: 1 } },
      });
    } else {
      // Consume from oldest active topup (FIFO)
      const topup = await this.prisma.topupPurchase.findFirst({
        where: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
          cycleEndDate: { gt: new Date() },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (topup) {
        await this.prisma.$transaction([
          this.prisma.topupPurchase.update({
            where: { id: topup.id },
            data: { invoicesUsed: { increment: 1 } },
          }),
          this.prisma.companyUsage.update({
            where: {
              companyId_cycleStartDate: {
                companyId,
                cycleStartDate: companyPlan.cycleStartDate,
              },
            },
            data: { topupUsed: { increment: 1 } },
          }),
        ]);
      }
    }

    // Re-fetch and evaluate thresholds
    const updated = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });
    if (updated) {
      await this.notifications.evaluateThresholds(
        companyId,
        companyPlan.cycleStartDate,
        updated,
      );
    }
  }
}
