import { Module } from '@nestjs/common';
import { ContingencyService } from './contingency.service';
import { ContingencyController } from './contingency.controller';
import { SigningModule } from '../signing/signing.module';
import { DgiiModule } from '../dgii/dgii.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [SigningModule, DgiiModule, CertificatesModule, QueueModule, BillingModule],
  controllers: [ContingencyController],
  providers: [ContingencyService],
  exports: [ContingencyService],
})
export class ContingencyModule {}
