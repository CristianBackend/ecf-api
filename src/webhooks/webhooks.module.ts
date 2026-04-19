import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { QUEUES } from '../queue/queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.WEBHOOK_DELIVERY })],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryProcessor],
  exports: [WebhooksService, BullModule],
})
export class WebhooksModule {}
