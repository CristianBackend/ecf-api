import { Module } from '@nestjs/common';
import { CompanyBillingService } from './company-billing.service';
import { CompanyBillingController } from './company-billing.controller';
import { UsageService } from './usage.service';

/**
 * Billing-v2: company-level, per-emission billing only. The legacy tenant-level
 * system (BillingService, BillingScheduler, RenewPlansJob, threshold
 * notifications, topups) was removed.
 */
@Module({
  controllers: [CompanyBillingController],
  providers: [CompanyBillingService, UsageService],
  exports: [CompanyBillingService, UsageService],
})
export class BillingModule {}
