import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingService } from './billing.service';
import { DistributedLockService } from '../common/services/distributed-lock.service';

/**
 * Billing Scheduler
 *
 * Runs a single hourly job to expire TenantPlans whose 30-day window has
 * elapsed. Wrapped in a Redis distributed lock so only one pod does the
 * work per tick in a multi-replica deployment.
 */
@Injectable()
export class BillingScheduler {
  private static readonly EXPIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 min

  constructor(
    private readonly billingService: BillingService,
    private readonly lock: DistributedLockService,
    @InjectPinoLogger(BillingScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'billing-expire-plans' })
  async expirePlans(): Promise<void> {
    await this.lock.withLock(
      'scheduler:billing-expire-plans',
      BillingScheduler.EXPIRE_LOCK_TTL_MS,
      () => this.runExpiration(),
    );
  }

  private async runExpiration(): Promise<void> {
    try {
      const count = await this.billingService.expireStalePlans();
      if (count > 0) {
        this.logger.info(`Expired ${count} plan(s)`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Plan expiration job failed: ${message}`);
    }
  }
}
