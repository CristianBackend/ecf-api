import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { XmlBuilderModule } from '../xml-builder/xml-builder.module';
import { SigningModule } from '../signing/signing.module';
import { DgiiModule } from '../dgii/dgii.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

import { EcfProcessingProcessor } from './ecf-processing.processor';
import { StatusPollProcessor } from './status-poll.processor';
import { CertificateCheckProcessor } from './certificate-check.processor';
import { QueueService } from './queue.service';
import { QUEUES } from './queue.constants';

// Re-export for convenience
export { QUEUES } from './queue.constants';

@Module({
  imports: [
    // The three queues the processors in this module consume. The
    // WEBHOOK_DELIVERY queue is registered in WebhooksModule because its
    // processor and producer both live there.
    BullModule.registerQueue(
      { name: QUEUES.ECF_PROCESSING },
      { name: QUEUES.ECF_STATUS_POLL },
      { name: QUEUES.CERTIFICATE_CHECK },
    ),

    PrismaModule,
    XmlBuilderModule,
    SigningModule,
    DgiiModule,
    CertificatesModule,
    WebhooksModule,
  ],
  providers: [
    EcfProcessingProcessor,
    StatusPollProcessor,
    CertificateCheckProcessor,
    QueueService,
  ],
  exports: [BullModule, QueueService, WebhooksModule],
})
export class QueueModule {}
