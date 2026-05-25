import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyPlanStatus } from '@prisma/client';
import { DistributedLockService } from '../../common/services/distributed-lock.service';

@Injectable()
export class RenewPlansJob {
  private static readonly LOCK_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: DistributedLockService,
    @InjectPinoLogger(RenewPlansJob.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron('0 0 * * *', { name: 'billing-renew-company-plans' })
  async renewExpiredPlans(): Promise<void> {
    await this.lock.withLock(
      'scheduler:billing-renew-company-plans',
      RenewPlansJob.LOCK_TTL_MS,
      () => this.runRenewal(),
    );
  }

  private async runRenewal(): Promise<void> {
    const now = new Date();

    const expiredPlans = await this.prisma.companyPlan.findMany({
      where: {
        cycleEndDate: { lte: now },
        status: { in: [CompanyPlanStatus.ACTIVE, CompanyPlanStatus.EXHAUSTED] },
      },
      include: { plan: true },
    });

    this.logger.info(`RenewPlansJob: processing ${expiredPlans.length} expired company plan(s)`);

    for (const companyPlan of expiredPlans) {
      try {
        if (companyPlan.autoRenew) {
          const newStart = companyPlan.cycleEndDate;
          const newEnd = new Date(newStart.getTime() + 30 * 24 * 60 * 60 * 1000);

          await this.prisma.$transaction([
            this.prisma.companyPlan.update({
              where: { id: companyPlan.id },
              data: {
                cycleStartDate: newStart,
                cycleEndDate: newEnd,
                status: CompanyPlanStatus.ACTIVE,
              },
            }),
            this.prisma.companyUsage.create({
              data: {
                companyId: companyPlan.companyId,
                cycleStartDate: newStart,
                baseUsed: 0,
                topupUsed: 0,
                totalQuota: companyPlan.plan.includedInvoices,
              },
            }),
          ]);

          this.logger.info({ companyId: companyPlan.companyId }, 'Auto-renewed company billing cycle');
        } else {
          await this.prisma.companyPlan.update({
            where: { id: companyPlan.id },
            data: { status: CompanyPlanStatus.EXPIRED },
          });

          this.logger.info(
            { companyId: companyPlan.companyId },
            'Company billing plan expired (autoRenew=false)',
          );
        }
      } catch (err) {
        this.logger.error(
          { err, companyId: companyPlan.companyId },
          'RenewPlansJob: failed to process company plan renewal',
        );
      }
    }
  }
}
