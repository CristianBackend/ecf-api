/**
 * WebhookDeliveryProcessor tests
 *
 * Covers the BullMQ-driven delivery path:
 * - Skips when no subscriptions match the event (filtered by subscription
 *   events + isActive)
 * - Signs body with HMAC-SHA256 using secretHash, emits X-ECF-* headers
 * - 5xx / network errors rethrow so BullMQ retries
 * - 10 consecutive failures in 24h auto-deactivates the subscription
 */
import {
  WebhookDeliveryProcessor,
  WEBHOOK_AUTO_DEACTIVATE_THRESHOLD,
  computeHmacSha256,
} from './webhook-delivery.processor';
import { WebhookEvent } from '@prisma/client';
import * as crypto from 'crypto';

type Mock = jest.Mock;

function makeProcessor() {
  const prisma = {
    webhookSubscription: {
      findMany: jest.fn() as Mock,
      update: jest.fn(async () => ({})) as Mock,
    },
    webhookDelivery: {
      create: jest.fn(async () => ({})) as Mock,
      count: jest.fn(async () => 0) as Mock,
    },
  };
  const processor = new WebhookDeliveryProcessor(prisma as any);
  return { processor, prisma };
}

function makeJob(data: Partial<any> = {}): any {
  return {
    id: 'job-1',
    data: {
      tenantId: 'tenant-1',
      event: WebhookEvent.INVOICE_ACCEPTED,
      payload: { invoiceId: 'inv-1' },
      deliveryId: '11111111-1111-4111-8111-111111111111',
      emittedAt: '2026-04-19T12:00:00.000Z',
      ...data,
    },
    opts: { attempts: 5 },
    attemptsMade: 0,
  };
}

function okResponse(body = 'ok', status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

describe('WebhookDeliveryProcessor', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('skips when no subscriptions match the event (or all are inactive)', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([]);

    const result = await processor.process(makeJob());

    expect(result).toEqual({ delivered: 0, event: WebhookEvent.INVOICE_ACCEPTED });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only matches subscriptions where isActive=true AND the event is subscribed', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([]);

    await processor.process(
      makeJob({ event: WebhookEvent.INVOICE_ACCEPTED, tenantId: 't1' }),
    );

    const whereArg = prisma.webhookSubscription.findMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({
      tenantId: 't1',
      isActive: true,
      events: { has: WebhookEvent.INVOICE_ACCEPTED },
    });
  });

  it('delivers with X-ECF-* headers and a valid HMAC-SHA256 signature over the body', async () => {
    const { processor, prisma } = makeProcessor();
    const webhook = {
      id: 'wh-1',
      tenantId: 'tenant-1',
      url: 'https://example.com/webhook',
      secretHash: 'secret-key-for-hmac',
    };
    prisma.webhookSubscription.findMany.mockResolvedValue([webhook]);
    fetchSpy.mockResolvedValue(okResponse());

    await processor.process(makeJob());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-ECF-Event']).toBe(WebhookEvent.INVOICE_ACCEPTED);
    expect(init.headers['X-ECF-Delivery-Id']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(init.headers['X-ECF-Timestamp']).toBe('2026-04-19T12:00:00.000Z');
    expect(init.headers['User-Agent']).toBe('ECF-API-Webhook/1.0');

    // Verify HMAC signature is exactly sha256(body) using secretHash as key
    const bodyString = init.body as string;
    const expectedSig = crypto
      .createHmac('sha256', 'secret-key-for-hmac')
      .update(bodyString)
      .digest('hex');
    expect(init.headers['X-ECF-Signature']).toBe(`sha256=${expectedSig}`);

    // Body shape
    const parsed = JSON.parse(bodyString);
    expect(parsed.event).toBe(WebhookEvent.INVOICE_ACCEPTED);
    expect(parsed.deliveryId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.emittedAt).toBe('2026-04-19T12:00:00.000Z');
    expect(parsed.data).toEqual({ invoiceId: 'inv-1' });
  });

  it('HMAC helper matches a known-vector test case (regression guard)', () => {
    // A fixed body + fixed key must always hash to the same hex.
    const expected = crypto
      .createHmac('sha256', 'super-secret')
      .update('{"event":"INVOICE_ACCEPTED"}')
      .digest('hex');
    expect(computeHmacSha256('super-secret', '{"event":"INVOICE_ACCEPTED"}')).toBe(
      expected,
    );
  });

  it('rethrows on 5xx so BullMQ retries the job', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'wh-1', tenantId: 't1', url: 'https://x.example', secretHash: 's' },
    ]);
    fetchSpy.mockResolvedValue(okResponse('nope', 502));

    await expect(processor.process(makeJob())).rejects.toThrow(/HTTP 502/);
  });

  it('rethrows on network error (fetch rejection)', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'wh-1', tenantId: 't1', url: 'https://x.example', secretHash: 's' },
    ]);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processor.process(makeJob())).rejects.toThrow(/ECONNREFUSED/);
  });

  it(`auto-deactivates the subscription after ${WEBHOOK_AUTO_DEACTIVATE_THRESHOLD} failures in 24h`, async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'wh-1', tenantId: 't1', url: 'https://x.example', secretHash: 's' },
    ]);
    fetchSpy.mockResolvedValue(okResponse('server error', 500));
    prisma.webhookDelivery.count.mockResolvedValue(
      WEBHOOK_AUTO_DEACTIVATE_THRESHOLD,
    );

    await expect(processor.process(makeJob())).rejects.toThrow();

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      data: { isActive: false },
    });
  });

  it('does not deactivate until the failure threshold is reached', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'wh-1', tenantId: 't1', url: 'https://x.example', secretHash: 's' },
    ]);
    fetchSpy.mockResolvedValue(okResponse('server error', 500));
    prisma.webhookDelivery.count.mockResolvedValue(
      WEBHOOK_AUTO_DEACTIVATE_THRESHOLD - 1,
    );

    await expect(processor.process(makeJob())).rejects.toThrow();

    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('logs a delivery row with deliveredAt set only on success', async () => {
    const { processor, prisma } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      { id: 'wh-1', tenantId: 't1', url: 'https://x.example', secretHash: 's' },
    ]);
    fetchSpy.mockResolvedValue(okResponse('ok', 200));

    await processor.process(makeJob());

    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const created = prisma.webhookDelivery.create.mock.calls[0][0].data;
    expect(created.statusCode).toBe(200);
    expect(created.deliveredAt).toBeInstanceOf(Date);
  });
});
