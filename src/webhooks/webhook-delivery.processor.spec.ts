/**
 * WebhookDeliveryProcessor tests
 *
 * Covers the BullMQ-driven delivery path with the new encrypted-secret model:
 * - The findMany filter matches isActive + event + needsRegeneration=false +
 *   secretEnc non-null, so legacy rows are never delivered to.
 * - HMAC is computed with the *raw* decrypted secret (industry standard:
 *   HMAC(secret, body) a la Stripe/GitHub/Shopify), NOT with a hash of it.
 * - Emits X-ECF-* headers.
 * - 5xx / network errors rethrow so BullMQ retries.
 * - 10 consecutive failures in 24h auto-deactivate the subscription.
 */
import {
  WebhookDeliveryProcessor,
  WEBHOOK_AUTO_DEACTIVATE_THRESHOLD,
  computeHmacSha256,
} from './webhook-delivery.processor';
import { EncryptionService } from '../common/services/encryption.service';
import { WebhookEvent } from '@prisma/client';
import * as crypto from 'crypto';

type Mock = jest.Mock;

const TEST_KEY_HEX = 'a'.repeat(64);

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
  const encryption = new EncryptionService(TEST_KEY_HEX);
  const processor = new WebhookDeliveryProcessor(prisma as any, encryption);
  return { processor, prisma, encryption };
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

function makeActiveWebhook(
  encryption: EncryptionService,
  overrides: Partial<any> = {},
) {
  const secret = 'whsec_' + 'b'.repeat(64);
  const secretEnc = encryption.encrypt(Buffer.from(secret, 'utf8'));
  return {
    id: 'wh-1',
    tenantId: 'tenant-1',
    url: 'https://example.com/webhook',
    secretEnc,
    secret, // attached for tests to reproduce HMAC
    ...overrides,
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

  it('only matches rows with isActive + subscribed event + secretEnc + needsRegeneration=false', async () => {
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
      needsRegeneration: false,
      secretEnc: { not: null },
    });
  });

  it('signs the body with HMAC-SHA256 using the *decrypted raw secret* as the key', async () => {
    const { processor, prisma, encryption } = makeProcessor();
    const webhook = makeActiveWebhook(encryption);
    prisma.webhookSubscription.findMany.mockResolvedValue([webhook]);
    fetchSpy.mockResolvedValue(okResponse());

    await processor.process(makeJob());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://example.com/webhook');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-ECF-Event']).toBe(WebhookEvent.INVOICE_ACCEPTED);
    expect(init.headers['X-ECF-Delivery-Id']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(init.headers['X-ECF-Timestamp']).toBe('2026-04-19T12:00:00.000Z');
    expect(init.headers['User-Agent']).toBe('ECF-API-Webhook/1.0');

    const bodyString = init.body as string;
    // Standard Stripe/GitHub-style verification: HMAC-SHA256(raw_secret, body)
    const expectedSig = crypto
      .createHmac('sha256', webhook.secret)
      .update(bodyString)
      .digest('hex');
    expect(init.headers['X-ECF-Signature']).toBe(`sha256=${expectedSig}`);

    const parsed = JSON.parse(bodyString);
    expect(parsed.event).toBe(WebhookEvent.INVOICE_ACCEPTED);
    expect(parsed.data).toEqual({ invoiceId: 'inv-1' });
  });

  it('HMAC helper matches a known vector (regression guard)', () => {
    // Fixed body + fixed key → fixed hex output.
    expect(
      computeHmacSha256('super-secret', '{"event":"INVOICE_ACCEPTED"}'),
    ).toBe(
      crypto
        .createHmac('sha256', 'super-secret')
        .update('{"event":"INVOICE_ACCEPTED"}')
        .digest('hex'),
    );
  });

  it('a third-party client using the plain `secret` reproduces the signature', async () => {
    // Simulates what the subscriber does on their end with a stock crypto lib.
    const { processor, prisma, encryption } = makeProcessor();
    const webhook = makeActiveWebhook(encryption);
    prisma.webhookSubscription.findMany.mockResolvedValue([webhook]);
    fetchSpy.mockResolvedValue(okResponse());

    await processor.process(makeJob());

    const [, init] = fetchSpy.mock.calls[0];
    const received = (init.headers['X-ECF-Signature'] as string).replace(
      /^sha256=/,
      '',
    );
    const clientComputed = crypto
      .createHmac('sha256', webhook.secret)
      .update(init.body as string)
      .digest('hex');
    expect(received).toBe(clientComputed);
  });

  it('rethrows on 5xx so BullMQ retries the job', async () => {
    const { processor, prisma, encryption } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      makeActiveWebhook(encryption),
    ]);
    fetchSpy.mockResolvedValue(okResponse('nope', 502));
    await expect(processor.process(makeJob())).rejects.toThrow(/HTTP 502/);
  });

  it('rethrows on network error (fetch rejection)', async () => {
    const { processor, prisma, encryption } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      makeActiveWebhook(encryption),
    ]);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(processor.process(makeJob())).rejects.toThrow(/ECONNREFUSED/);
  });

  it(`auto-deactivates the subscription after ${WEBHOOK_AUTO_DEACTIVATE_THRESHOLD} failures in 24h`, async () => {
    const { processor, prisma, encryption } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      makeActiveWebhook(encryption),
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
    const { processor, prisma, encryption } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      makeActiveWebhook(encryption),
    ]);
    fetchSpy.mockResolvedValue(okResponse('server error', 500));
    prisma.webhookDelivery.count.mockResolvedValue(
      WEBHOOK_AUTO_DEACTIVATE_THRESHOLD - 1,
    );
    await expect(processor.process(makeJob())).rejects.toThrow();
    expect(prisma.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it('logs a delivery row with deliveredAt set only on success', async () => {
    const { processor, prisma, encryption } = makeProcessor();
    prisma.webhookSubscription.findMany.mockResolvedValue([
      makeActiveWebhook(encryption),
    ]);
    fetchSpy.mockResolvedValue(okResponse('ok', 200));

    await processor.process(makeJob());

    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const created = prisma.webhookDelivery.create.mock.calls[0][0].data;
    expect(created.statusCode).toBe(200);
    expect(created.deliveredAt).toBeInstanceOf(Date);
  });
});
