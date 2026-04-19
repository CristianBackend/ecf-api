/**
 * WebhooksService.emit() tests
 *
 * Enforces the single-emit-path invariant: every webhook goes through
 * WebhooksService.emit(), which enqueues to the WEBHOOK_DELIVERY BullMQ
 * queue with the correct event name, payload, and retry configuration.
 */
import { WebhooksService } from './webhooks.service';
import { WebhookEvent } from '@prisma/client';
import { WEBHOOK_MAX_ATTEMPTS } from './webhook-delivery.processor';

describe('WebhooksService.emit', () => {
  let service: WebhooksService;
  let queueAdd: jest.Mock;

  beforeEach(() => {
    queueAdd = jest.fn(async (_name: string, _data: any, _opts: any) => ({
      id: 'job-abc',
    }));
    const queue: any = { add: queueAdd };
    const prisma: any = {};
    service = new WebhooksService(prisma, queue);
  });

  it('enqueues a job with the event name, full payload, and 5-attempt custom backoff', async () => {
    const { jobId, deliveryId } = await service.emit(
      'tenant-1',
      WebhookEvent.INVOICE_QUEUED,
      { invoiceId: 'inv-1', encf: 'E310000000001' },
    );

    expect(jobId).toBe('job-abc');
    expect(deliveryId).toMatch(/^[0-9a-f-]{36}$/i); // UUID

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [jobName, jobData, opts] = queueAdd.mock.calls[0];

    expect(jobName).toBe(WebhookEvent.INVOICE_QUEUED);

    expect(jobData).toEqual({
      tenantId: 'tenant-1',
      event: WebhookEvent.INVOICE_QUEUED,
      payload: { invoiceId: 'inv-1', encf: 'E310000000001' },
      deliveryId,
      emittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });

    expect(opts).toEqual(
      expect.objectContaining({
        attempts: WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
      }),
    );
  });

  it('produces a unique deliveryId per emission', async () => {
    const first = await service.emit('t', WebhookEvent.INVOICE_ACCEPTED, {});
    const second = await service.emit('t', WebhookEvent.INVOICE_ACCEPTED, {});
    expect(first.deliveryId).not.toBe(second.deliveryId);
  });

  it('routes each event to its own job name so consumers can inspect by event', async () => {
    await service.emit('t', WebhookEvent.INVOICE_QUEUED, {});
    await service.emit('t', WebhookEvent.INVOICE_ACCEPTED, {});
    await service.emit('t', WebhookEvent.INVOICE_CONTINGENCY, {});

    const jobNames = queueAdd.mock.calls.map((c) => c[0]);
    expect(jobNames).toEqual([
      WebhookEvent.INVOICE_QUEUED,
      WebhookEvent.INVOICE_ACCEPTED,
      WebhookEvent.INVOICE_CONTINGENCY,
    ]);
  });
});
