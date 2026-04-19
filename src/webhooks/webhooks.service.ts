import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { WebhookEvent } from '@prisma/client';
import { QUEUES } from '../queue/queue.constants';
import {
  WebhookDeliveryJobData,
  WEBHOOK_MAX_ATTEMPTS,
} from './webhook-delivery.processor';

/**
 * WebhooksService owns the public API for webhook subscriptions and the
 * single emit() entry-point used by the rest of the app.
 *
 * There is **only one** public way to emit a webhook: {@link emit}. It
 * enqueues a WebhookDelivery job to BullMQ; the WebhookDeliveryProcessor
 * handles fan-out, HMAC signing, HTTP POST, retry/backoff, and auto-
 * deactivation. Callers never open HTTP connections themselves.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.WEBHOOK_DELIVERY)
    private readonly webhookQueue: Queue<WebhookDeliveryJobData>,
  ) {}

  /**
   * Emit a webhook event. Enqueues a delivery job; the actual HTTP POST
   * happens asynchronously on the WebhookDeliveryProcessor worker.
   */
  async emit(
    tenantId: string,
    event: WebhookEvent,
    payload: Record<string, any>,
  ): Promise<{ jobId: string; deliveryId: string }> {
    const deliveryId = crypto.randomUUID();
    const emittedAt = new Date().toISOString();

    const job = await this.webhookQueue.add(
      event,
      { tenantId, event, payload, deliveryId, emittedAt },
      {
        attempts: WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 604800 },
      },
    );

    this.logger.debug(`Emitted ${event} (delivery ${deliveryId}, job ${job.id})`);
    return { jobId: String(job.id), deliveryId };
  }

  // ============================================================
  // CRUD
  // ============================================================

  /**
   * Create a webhook subscription. Generates a fresh secret (returned only
   * once) and stores its SHA-256 hash, which is the HMAC key used by the
   * delivery processor — subscribers therefore verify signatures with
   * `sha256(secret).hex()` as the key.
   */
  async create(tenantId: string, dto: CreateWebhookDto) {
    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const webhook = await this.prisma.webhookSubscription.create({
      data: {
        tenantId,
        url: dto.url,
        events: dto.events,
        secretHash,
        isActive: true,
      },
    });

    this.logger.log(`Webhook created: ${webhook.id} → ${dto.url}`);

    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      note: '⚠️ Guarda el secret. No se mostrará de nuevo. Úsalo para verificar la firma HMAC.',
    };
  }

  async findAll(tenantId: string) {
    return this.prisma.webhookSubscription.findMany({
      where: { tenantId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { deliveries: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const webhook = await this.prisma.webhookSubscription.findFirst({
      where: { id, tenantId },
      include: {
        deliveries: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            event: true,
            statusCode: true,
            attempts: true,
            deliveredAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!webhook) throw new NotFoundException('Webhook no encontrado');
    return webhook;
  }

  async update(tenantId: string, id: string, dto: UpdateWebhookDto) {
    const webhook = await this.prisma.webhookSubscription.findFirst({
      where: { id, tenantId },
    });
    if (!webhook) throw new NotFoundException('Webhook no encontrado');

    return this.prisma.webhookSubscription.update({
      where: { id },
      data: {
        url: dto.url,
        events: dto.events,
        isActive: dto.isActive,
      },
    });
  }

  async delete(tenantId: string, id: string) {
    const webhook = await this.prisma.webhookSubscription.findFirst({
      where: { id, tenantId },
    });
    if (!webhook) throw new NotFoundException('Webhook no encontrado');

    await this.prisma.webhookSubscription.delete({ where: { id } });
    return { message: 'Webhook eliminado' };
  }
}
