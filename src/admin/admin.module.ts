import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { QUEUES } from '../queue/queue.constants';

import { AdminController } from './admin.controller';
import { MetricsService } from './metrics.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminInvoicesController } from './admin-invoices.controller';
import { AdminInvoicesService } from './admin-invoices.service';
import { AdminWebhooksController } from './admin-webhooks.controller';
import { AdminWebhooksService } from './admin-webhooks.service';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminHealthController } from './admin-health.controller';
import { AdminHealthService } from './admin-health.service';

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    BullModule.registerQueue({ name: QUEUES.WEBHOOK_DELIVERY }),
    SchedulerModule,
  ],
  controllers: [
    AdminController,
    AdminTenantsController,
    AdminInvoicesController,
    AdminWebhooksController,
    AdminAuditController,
    AdminHealthController,
  ],
  providers: [
    MetricsService,
    AdminTenantsService,
    AdminInvoicesService,
    AdminWebhooksService,
    AdminAuditService,
    AdminHealthService,
  ],
})
export class AdminModule {}
