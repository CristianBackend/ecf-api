import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES } from '../queue/queue.constants';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDeliveryJobData,
  WEBHOOK_RETRY_DELAYS,
} from '../webhooks/webhook-delivery.processor';

export interface AdminDeliveriesFilter {
  page?: number;
  limit?: number;
  tenantId?: string;
  subscriptionId?: string;
  event?: string;
  statusCode?: number;
  dateFrom?: string;
  dateTo?: string;
  onlyFailed?: boolean;
}

const PAYLOAD_TRUNCATE = 500;
const RESPONSE_TRUNCATE = 500;

@Injectable()
export class AdminWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.WEBHOOK_DELIVERY)
    private readonly webhookQueue: Queue<WebhookDeliveryJobData>,
  ) {}

  async findDeliveries(filter: AdminDeliveriesFilter) {
    const page  = Math.max(1, filter.page  ?? 1);
    const limit = Math.min(filter.limit ?? 20, 100);
    const skip  = (page - 1) * limit;

    const where: any = {};
    if (filter.tenantId)       where.tenantId       = filter.tenantId;
    if (filter.subscriptionId) where.subscriptionId = filter.subscriptionId;
    if (filter.event)          where.event          = filter.event;
    if (filter.statusCode)     where.statusCode     = filter.statusCode;
    if (filter.onlyFailed)     where.deliveredAt    = null;
    if (filter.dateFrom || filter.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) where.createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo)   where.createdAt.lte = new Date(filter.dateTo);
    }

    const [items, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          subscription: { select: { url: true, events: true } },
        },
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);

    const enriched = items.map((d) => ({
      id: d.id,
      tenantId: d.tenantId,
      subscriptionId: d.subscriptionId,
      url: d.subscription?.url,
      event: d.event,
      payload: this.truncate(JSON.stringify(d.payload), PAYLOAD_TRUNCATE),
      statusCode: d.statusCode,
      responseBody: this.truncate(d.responseBody ?? '', RESPONSE_TRUNCATE),
      attempts: d.attempts,
      maxAttempts: d.maxAttempts,
      nextRetryAt: d.nextRetryAt,
      deliveredAt: d.deliveredAt,
      createdAt: d.createdAt,
    }));

    return { items: enriched, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findDelivery(id: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: { subscription: { select: { url: true, events: true, tenantId: true } } },
    });
    if (!delivery) throw new NotFoundException(`Delivery ${id} no encontrado`);
    return {
      ...delivery,
      payload: this.truncate(JSON.stringify(delivery.payload), PAYLOAD_TRUNCATE),
      responseBody: this.truncate(delivery.responseBody ?? '', RESPONSE_TRUNCATE),
    };
  }

  async retryDelivery(id: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      include: { subscription: true },
    });
    if (!delivery) throw new NotFoundException(`Delivery ${id} no encontrado`);

    if (delivery.attempts < delivery.maxAttempts) {
      throw new BadRequestException(
        `Delivery todavía tiene ${delivery.maxAttempts - delivery.attempts} intentos pendientes. ` +
        `Solo se puede forzar reintento cuando se agotaron todos los intentos (attempts >= maxAttempts).`,
      );
    }

    // Re-queue with the original data
    const jobData: WebhookDeliveryJobData = {
      tenantId: delivery.tenantId,
      event: delivery.event,
      payload: delivery.payload as any,
      deliveryId: delivery.id,
      emittedAt: delivery.createdAt.toISOString(),
    };

    const job = await this.webhookQueue.add('deliver', jobData, {
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: {
        type: 'custom',
        delay: WEBHOOK_RETRY_DELAYS[0],
      },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    });

    // Reset delivery record
    await this.prisma.webhookDelivery.update({
      where: { id },
      data: { attempts: 0, nextRetryAt: null, deliveredAt: null, statusCode: null },
    });

    return { success: true, jobId: String(job.id), deliveryId: id };
  }

  private truncate(s: string, max: number): string {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
}
