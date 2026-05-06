import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingScheduler } from './billing.scheduler';

@Module({
  providers: [BillingService, BillingScheduler],
  exports: [BillingService],
})
export class BillingModule {}
