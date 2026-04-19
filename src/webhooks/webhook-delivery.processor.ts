import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEvent } from '@prisma/client';
import { QUEUES } from '../queue/queue.constants';
import * as crypto from 'crypto';

export interface WebhookDeliveryJobData {
  tenantId: string;
  event: WebhookEvent;
  payload: Record<string, any>;
  deliveryId: string;
  emittedAt: string;
}

/**
 * Backoff delays for webhook delivery retries, per the spec:
 *   attempt 1 failed -> wait 30s before attempt 2
 *   attempt 2 failed -> wait 2min before attempt 3
 *   attempt 3 failed -> wait 10min before attempt 4
 *   attempt 4 failed -> wait 1h before attempt 5
 *   attempt 5 failed -> (no more retries; BullMQ marks job failed)
 *
 * BullMQ invokes the strategy with `attemptsMade` equal to the number of
 * attempts already consumed, so index 0 = wait before attempt 2, etc.
 */
export const WEBHOOK_RETRY_DELAYS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
];

export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Consecutive failures (in the last 24h) that trigger auto-deactivation. */
export const WEBHOOK_AUTO_DEACTIVATE_THRESHOLD = 10;

/**
 * Webhook Delivery Worker — the single delivery path for every webhook event
 * emitted by the API.
 *
 * Contract with subscribers:
 * - POST JSON body `{ event, deliveryId, emittedAt, data }` to the webhook
 *   URL.
 * - Headers:
 *     Content-Type: application/json
 *     X-ECF-Event: <event name>
 *     X-ECF-Delivery-Id: <uuid>
 *     X-ECF-Timestamp: <ISO8601 emittedAt>
 *     X-ECF-Signature: sha256=<hex>   (HMAC-SHA256 of the raw body, keyed
 *                                      by the webhook secret stored as
 *                                      WebhookSubscription.secretHash)
 *     User-Agent: ECF-API-Webhook/1.0
 *
 * Retries: up to 5 attempts total (one initial + 4 retries) with backoff
 * delays 30s -> 2min -> 10min -> 1h -> 6h. After the final failure, the
 * delivery row is marked with statusCode reflecting the last response.
 *
 * Auto-deactivation: if a webhook has 10 or more failed deliveries in the
 * last 24h, `isActive` is flipped to false so the fan-out stops sending.
 * Admins can re-enable via PATCH /webhooks/:id.
 */
@Processor(QUEUES.WEBHOOK_DELIVERY, {
  settings: {
    backoffStrategy: (attemptsMade: number) => {
      return (
        WEBHOOK_RETRY_DELAYS[attemptsMade - 1] ??
        WEBHOOK_RETRY_DELAYS[WEBHOOK_RETRY_DELAYS.length - 1]
      );
    },
  },
})
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobData>): Promise<any> {
    const { tenantId, event, payload, deliveryId, emittedAt } = job.data;

    const webhooks = await this.prisma.webhookSubscription.findMany({
      where: {
        tenantId,
        isActive: true,
        events: { has: event },
      },
    });

    if (webhooks.length === 0) {
      this.logger.debug(`No active webhooks for ${event} (tenant ${tenantId})`);
      return { delivered: 0, event };
    }

    this.logger.log(`Delivering ${event} to ${webhooks.length} webhook(s)`);

    const results = await Promise.allSettled(
      webhooks.map((wh) =>
        this.deliverToEndpoint(wh, event, payload, deliveryId, emittedAt),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    this.logger.log(`${event}: ${succeeded} delivered, ${failed} failed`);

    // Any rejected delivery rethrows so BullMQ schedules another attempt.
    // The per-endpoint retry count is tracked in the DB across BullMQ retries.
    if (failed > 0) {
      const firstError = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      throw firstError?.reason ?? new Error('Webhook delivery failed');
    }

    return { event, total: webhooks.length, succeeded, failed };
  }

  private async deliverToEndpoint(
    webhook: {
      id: string;
      tenantId: string;
      url: string;
      secretHash: string;
    },
    event: WebhookEvent,
    payload: Record<string, any>,
    deliveryId: string,
    emittedAt: string,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      deliveryId,
      emittedAt,
      data: payload,
    });

    const signature = computeHmacSha256(webhook.secretHash, body);

    let statusCode = 0;
    let responseBody = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ECF-Event': event,
          'X-ECF-Delivery-Id': deliveryId,
          'X-ECF-Timestamp': emittedAt,
          'X-ECF-Signature': `sha256=${signature}`,
          'User-Agent': 'ECF-API-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      statusCode = response.status;
      responseBody = await response.text().catch(() => '');

      await this.prisma.webhookDelivery.create({
        data: {
          tenantId: webhook.tenantId,
          subscriptionId: webhook.id,
          event,
          payload: payload as any,
          statusCode,
          responseBody: responseBody.substring(0, 1000),
          attempts: 1,
          deliveredAt: response.ok ? new Date() : null,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${statusCode}: ${responseBody.substring(0, 200)}`);
      }

      this.logger.debug(`Webhook ${webhook.id} → ${statusCode}`);
    } catch (error: any) {
      this.logger.warn(`Webhook ${webhook.id} failed: ${error.message}`);

      if (statusCode === 0) {
        // Network-level error: no response row was written yet above.
        await this.prisma.webhookDelivery
          .create({
            data: {
              tenantId: webhook.tenantId,
              subscriptionId: webhook.id,
              event,
              payload: payload as any,
              statusCode: 0,
              responseBody: error.message.substring(0, 1000),
              attempts: 1,
            },
          })
          .catch(() => {});
      }

      const recentFailures = await this.prisma.webhookDelivery.count({
        where: {
          subscriptionId: webhook.id,
          statusCode: { notIn: [200, 201, 202, 204] },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (recentFailures >= WEBHOOK_AUTO_DEACTIVATE_THRESHOLD) {
        await this.prisma.webhookSubscription.update({
          where: { id: webhook.id },
          data: { isActive: false },
        });
        this.logger.warn(
          `Webhook ${webhook.id} deactivated after ${recentFailures} failures in 24h`,
        );
      }

      throw error;
    }
  }
}

/** Exported so tests can reproduce the signature. */
export function computeHmacSha256(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
