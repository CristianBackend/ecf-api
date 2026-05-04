import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { AdminWebhooksService } from './admin-webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES } from '../queue/queue.constants';

const DELIVERY = {
  id: 'del-1', tenantId: 't-1', subscriptionId: 'sub-1',
  event: 'invoice.accepted', payload: { event: 'invoice.accepted', data: {} },
  statusCode: 500, responseBody: 'Internal Server Error',
  attempts: 5, maxAttempts: 5,
  nextRetryAt: null, deliveredAt: null,
  createdAt: new Date(),
  subscription: { url: 'https://example.com/wh', events: ['invoice.accepted'] },
};

describe('AdminWebhooksService', () => {
  let service: AdminWebhooksService;
  let prisma: any;
  let webhookQueue: any;

  beforeEach(async () => {
    prisma = {
      webhookDelivery: {
        findMany: jest.fn().mockResolvedValue([DELIVERY]),
        findUnique: jest.fn().mockResolvedValue(DELIVERY),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue(DELIVERY),
      },
    };
    webhookQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminWebhooksService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(QUEUES.WEBHOOK_DELIVERY), useValue: webhookQueue },
      ],
    }).compile();

    service = module.get<AdminWebhooksService>(AdminWebhooksService);
  });

  it('findDeliveries returns paginated list with truncated payload', async () => {
    const result = await service.findDeliveries({});
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0].url).toBe('https://example.com/wh');
  });

  it('findDeliveries applies onlyFailed filter', async () => {
    await service.findDeliveries({ onlyFailed: true });
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deliveredAt: null }) }),
    );
  });

  it('findDelivery throws NotFoundException when not found', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue(null);
    await expect(service.findDelivery('missing')).rejects.toThrow(NotFoundException);
  });

  it('retryDelivery re-enqueues and resets delivery record', async () => {
    const result = await service.retryDelivery('del-1');
    expect(result.success).toBe(true);
    expect(webhookQueue.add).toHaveBeenCalledWith('deliver', expect.objectContaining({ deliveryId: 'del-1' }), expect.any(Object));
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attempts: 0 }) }),
    );
  });

  it('retryDelivery throws BadRequestException if attempts < maxAttempts', async () => {
    prisma.webhookDelivery.findUnique.mockResolvedValue({ ...DELIVERY, attempts: 2, maxAttempts: 5 });
    await expect(service.retryDelivery('del-1')).rejects.toThrow(BadRequestException);
  });
});
