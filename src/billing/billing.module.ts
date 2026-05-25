import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingScheduler } from './billing.scheduler';
import { CompanyBillingService } from './company-billing.service';
import { CompanyBillingController } from './company-billing.controller';
import { UsageService } from './usage.service';
import { BillingNotificationsService } from './notifications/billing-notifications.service';
import { RenewPlansJob } from './jobs/renew-plans.job';

@Module({
  controllers: [CompanyBillingController],
  providers: [
    BillingService,
    BillingScheduler,
    CompanyBillingService,
    UsageService,
    BillingNotificationsService,
    RenewPlansJob,
  ],
  exports: [BillingService, CompanyBillingService, UsageService],
})
export class BillingModule {}
