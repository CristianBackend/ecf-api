/**
 * WebhooksService tests
 *
 * Covers:
 * - The single-emit-path invariant: every webhook goes through
 *   WebhooksService.emit(), which enqueues to the WEBHOOK_DELIVERY BullMQ
 *   queue with the correct event name, payload, and retry configuration.
 * - create() returns the raw secret exactly once, persists the AES-256-GCM
 *   ciphertext in the secretEnc column, and leaves the deprecated hash
 *   column untouched for new rows.
 */
import { WebhooksService } from './webhooks.service';
import { EncryptionService } from '../common/services/encryption.service';
import { WebhookEvent } from '@prisma/client';
import { WEBHOOK_MAX_ATTEMPTS } from './webhook-delivery.processor';
import * as crypto from 'crypto';

const TEST_KEY_HEX = 'f'.repeat(64); // 32 bytes of 0xff

describe('WebhooksService', () => {
  let service: WebhooksService;
  let queueAdd: jest.Mock;
  let prismaCreate: jest.Mock;
  let encryption: EncryptionService;

  beforeEach(() => {
    encryption = new EncryptionService(TEST_KEY_HEX);
    queueAdd = jest.fn(async () => ({ id: 'job-abc' }));
    prismaCreate = jest.fn(async ({ data }: any) => ({
      id: 'wh-uuid-1',
      ...data,
      createdAt: new Date('2026-04-19T00:00:00Z'),
    }));
    const queue: any = { add: queueAdd };
    const prisma: any = {
      webhookSubscription: { create: prismaCreate },
    };
    service = new WebhooksService(prisma, encryption, queue);
  });

  describe('emit()', () => {
    it('enqueues a job with the event name, full payload, and 5-attempt custom backoff', async () => {
      const { jobId, deliveryId } = await service.emit(
        'tenant-1',
        WebhookEvent.INVOICE_QUEUED,
        { invoiceId: 'inv-1', encf: 'E310000000001' },
      );

      expect(jobId).toBe('job-abc');
      expect(deliveryId).toMatch(/^[0-9a-f-]{36}$/i);

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

    it('routes each event to its own job name', async () => {
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

  describe('create()', () => {
    it('persists the secret as AES-GCM ciphertext and leaves the deprecated hash column untouched', async () => {
      const result = await service.create('tenant-1', {
        url: 'https://example.com/hook',
        events: [WebhookEvent.INVOICE_ACCEPTED],
      });

      expect(prismaCreate).toHaveBeenCalledTimes(1);
      const persisted = prismaCreate.mock.calls[0][0].data;
      const persistedKeys = Object.keys(persisted);

      // The raw secret is returned once…
      expect(result.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
      // …the row stores only the encrypted form (no legacy hash field).
      expect(persistedKeys).not.toContain('secret_hash');
      expect(persistedKeys).not.toContain('secret-hash'); // future-proofing
      expect(persisted.secretEnc).toBeInstanceOf(Buffer);
      expect(persisted.needsRegeneration).toBe(false);

      // The stored ciphertext decrypts back to the raw secret.
      const roundTripped = encryption
        .decrypt(persisted.secretEnc as Buffer)
        .toString('utf8');
      expect(roundTripped).toBe(result.secret);
    });

    it('uses the stored ciphertext as input to the industry-standard HMAC(secret, body)', async () => {
      const result = await service.create('tenant-1', {
        url: 'https://example.com/hook',
        events: [WebhookEvent.INVOICE_ACCEPTED],
      });

      const persisted = prismaCreate.mock.calls[0][0].data;
      const secret = encryption
        .decrypt(persisted.secretEnc as Buffer)
        .toString('utf8');

      const body = '{"event":"INVOICE_ACCEPTED"}';
      const expected = crypto
        .createHmac('sha256', result.secret)
        .update(body)
        .digest('hex');
      const actual = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      expect(actual).toBe(expected);
    });
  });
});
