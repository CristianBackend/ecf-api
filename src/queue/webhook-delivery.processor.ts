import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEvent } from '@prisma/client';
import { QUEUES } from './queue.constants';
import * as crypto from 'crypto';

export interface WebhookDeliveryJobData {
  tenantId: string;
  event: WebhookEvent;
  payload: Record<string, any>;
}

/**
 * Webhook Delivery Worker
 *
 * Delivers webhook events to all subscribed endpoints.
 *
 * Features:
 * - HMAC-SHA256 signature in X-Webhook-Signature header
 * - 10 second timeout per delivery
 * - Automatic retry with exponential backoff (3 attempts via BullMQ)
 * - Logs delivery attempts in webhook_deliveries table
 * - Deactivates webhook after 10 consecutive failed deliveries
 */
@Processor(QUEUES.WEBHOOK_DELIVERY)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobData>): Promise<any> {
    const { tenantId, event, payload } = job.data;

    // Find all active webhooks subscribed to this event
    const webhooks = await this.prisma.webhookSubscription.findMany({
      where: {
        tenantId,
        isActive: true,
        events: { has: event },
      },
    });

    if (webhooks.length === 0) {
      return { delivered: 0, event };
    }

    this.logger.log(`Delivering ${event} to ${webhooks.length} webhook(s)`);

    const results = await Promise.allSettled(
      webhooks.map(wh => this.deliverToEndpoint(wh, event, payload)),
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    this.logger.log(`${event}: ${succeeded} delivered, ${failed} failed`);

    return { event, total: webhooks.length, succeeded, failed };
  }

  private async deliverToEndpoint(
    webhook: any,
    event: WebhookEvent,
    payload: Record<string, any>,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    // Generate HMAC signature using the stored secret hash
    const signature = crypto
      .createHmac('sha256', webhook.secretHash)
      .update(body)
      .digest('hex');

    let statusCode = 0;
    let responseBody = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-ID': webhook.id,
          'User-Agent': 'ECF-API-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      statusCode = response.status;
      responseBody = await response.text().catch(() => '');

      // Log successful delivery
      await this.prisma.webhookDelivery.create({
        data: {
          tenantId: webhook.tenantId,
          subscriptionId: webhook.id,
          event,
          payload: payload as any,
          statusCode,
          responseBody: responseBody.substring(0, 1000),
          attempts: 1,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${statusCode}: ${responseBody.substring(0, 200)}`);
      }

      this.logger.debug(`Webhook ${webhook.id} → ${statusCode}`);

    } catch (error: any) {
      this.logger.warn(`Webhook ${webhook.id} failed: ${error.message}`);

      // Log failed delivery
      await this.prisma.webhookDelivery.create({
        data: {
          tenantId: webhook.tenantId,
          subscriptionId: webhook.id,
          event,
          payload: payload as any,
          statusCode: statusCode || 0,
          responseBody: error.message.substring(0, 1000),
          attempts: 1,
        },
      }).catch(() => {}); // don't fail the job if logging fails

      // Check consecutive failures — count recent failed deliveries
      const recentFailures = await this.prisma.webhookDelivery.count({
        where: {
          subscriptionId: webhook.id,
          statusCode: { notIn: [200, 201, 202, 204] },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // last 24h
        },
      });

      if (recentFailures >= 10) {
        await this.prisma.webhookSubscription.update({
          where: { id: webhook.id },
          data: { isActive: false },
        });
        this.logger.warn(
          `Webhook ${webhook.id} deactivated after ${recentFailures} failures in 24h`,
        );
      }

      throw error; // BullMQ will handle retry
    }
  }
}
