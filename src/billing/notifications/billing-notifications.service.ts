import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingAlertLevel, CompanyPlanStatus } from '@prisma/client';

type UsageSnapshot = {
  baseUsed: number;
  topupUsed: number;
  totalQuota: number;
  notified70: boolean;
  notified85: boolean;
  notified95: boolean;
  notified100: boolean;
};

@Injectable()
export class BillingNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(BillingNotificationsService.name)
    private readonly logger: PinoLogger,
  ) {}

  async evaluateThresholds(
    companyId: string,
    cycleStartDate: Date,
    usage: UsageSnapshot,
  ): Promise<void> {
    const totalUsed = usage.baseUsed + usage.topupUsed;
    const pct = usage.totalQuota > 0 ? (totalUsed / usage.totalQuota) * 100 : 0;

    const updates: Partial<Record<
      'notified70' | 'notified85' | 'notified95' | 'notified100',
      boolean
    >> = {};

    if (pct >= 70 && !usage.notified70) {
      updates.notified70 = true;
      await this.createAlert(
        companyId,
        BillingAlertLevel.INFO,
        70,
        `Has utilizado el 70% de tu cuota (${totalUsed}/${usage.totalQuota} facturas)`,
      );
    }
    if (pct >= 85 && !usage.notified85) {
      updates.notified85 = true;
      await this.createAlert(
        companyId,
        BillingAlertLevel.WARNING,
        85,
        `Has utilizado el 85% de tu cuota (${totalUsed}/${usage.totalQuota} facturas)`,
      );
    }
    if (pct >= 95 && !usage.notified95) {
      updates.notified95 = true;
      await this.createAlert(
        companyId,
        BillingAlertLevel.CRITICAL,
        95,
        `Has utilizado el 95% de tu cuota (${totalUsed}/${usage.totalQuota} facturas)`,
      );
    }
    if (pct >= 100 && !usage.notified100) {
      updates.notified100 = true;
      await this.createAlert(
        companyId,
        BillingAlertLevel.BLOCKED,
        100,
        `Cuota agotada (${totalUsed}/${usage.totalQuota} facturas). Adquiere un topup para continuar.`,
      );
      await this.prisma.companyPlan.update({
        where: { companyId },
        data: { status: CompanyPlanStatus.EXHAUSTED },
      });
    }

    if (Object.keys(updates).length > 0) {
      await this.prisma.companyUsage.update({
        where: { companyId_cycleStartDate: { companyId, cycleStartDate } },
        data: updates,
      });
    }
  }

  private async createAlert(
    companyId: string,
    level: BillingAlertLevel,
    percentage: number,
    message: string,
  ): Promise<void> {
    await this.prisma.billingAlert.create({
      data: { companyId, level, message, percentage },
    });

    // Email stub — log only, never throw
    this.logger.info(
      { companyId, level, percentage },
      'Billing threshold reached — email notification stub',
    );
  }
}
