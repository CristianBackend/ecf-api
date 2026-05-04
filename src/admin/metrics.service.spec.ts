import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getLoggerToken } from 'nestjs-pino';
import { MetricsService } from './metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

const QUEUE_STATS = {
  ecfProcessing: { waiting: 0, active: 0, completed: 10, failed: 0, delayed: 0 },
  statusPoll:    { waiting: 0, active: 0, completed: 5,  failed: 0, delayed: 0 },
  certificateCheck: { waiting: 0, active: 0, completed: 1, failed: 0, delayed: 0 },
};

function makePrisma() {
  return {
    tenant: { count: jest.fn().mockResolvedValue(0) },
    company: { count: jest.fn().mockResolvedValue(0) },
    invoice: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    certificate: { count: jest.fn().mockResolvedValue(0) },
    webhookSubscription: { count: jest.fn().mockResolvedValue(0) },
    webhookDelivery: { count: jest.fn().mockResolvedValue(0) },
  };
}

describe('MetricsService', () => {
  let service: MetricsService;
  let prisma: ReturnType<typeof makePrisma>;
  let queueService: { getQueueStats: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    queueService = { getQueueStats: jest.fn().mockResolvedValue(QUEUE_STATS) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricsService,
        { provide: PrismaService, useValue: prisma },
        { provide: QueueService, useValue: queueService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('development') } },
        { provide: getLoggerToken(MetricsService.name), useValue: { debug: jest.fn(), info: jest.fn() } },
      ],
    }).compile();

    service = module.get<MetricsService>(MetricsService);
  });

  it('returns correct structure with all required top-level keys', async () => {
    const metrics = await service.getGlobalMetrics();
    expect(metrics).toMatchObject({
      tenants: expect.objectContaining({ total: 0, active: 0, newThisMonth: 0 }),
      companies: expect.objectContaining({ total: 0, active: 0 }),
      invoices: expect.objectContaining({ total: 0, today: 0, thisMonth: 0, byStatus: {}, byEcfType: {} }),
      certificates: expect.objectContaining({ total: 0, active: 0, expiringSoon: 0, expired: 0 }),
      webhooks: expect.objectContaining({ totalSubscriptions: 0, activeSubscriptions: 0 }),
      queues: QUEUE_STATS,
      system: expect.objectContaining({ nodeEnv: 'development' }),
    });
  });

  it('groups invoices by status correctly', async () => {
    prisma.invoice.groupBy
      .mockResolvedValueOnce([
        { status: 'ACCEPTED', _count: { status: 42 } },
        { status: 'REJECTED', _count: { status: 3 } },
      ])
      .mockResolvedValue([]);

    const metrics = await service.getGlobalMetrics() as any;
    expect(metrics.invoices.byStatus).toEqual({ ACCEPTED: 42, REJECTED: 3 });
  });

  it('caches result — second call within TTL does not re-query DB', async () => {
    await service.getGlobalMetrics();
    const callCount = (prisma.tenant.count as jest.Mock).mock.calls.length;

    await service.getGlobalMetrics(); // cached
    expect((prisma.tenant.count as jest.Mock).mock.calls.length).toBe(callCount);
    expect(service.isCacheWarm()).toBe(true);
  });

  it('system.uptime is a positive number', async () => {
    const metrics = await service.getGlobalMetrics() as any;
    expect(metrics.system.uptime).toBeGreaterThan(0);
  });
});
