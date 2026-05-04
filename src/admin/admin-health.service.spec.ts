import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AdminHealthService } from './admin-health.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { LOCK_REDIS_CLIENT } from '../common/services/distributed-lock.service';
import { SchedulerService } from '../scheduler/scheduler.service';

describe('AdminHealthService', () => {
  let service: AdminHealthService;
  let prisma: any;
  let redis: any;
  let queueService: any;

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };
    queueService = { getQueueStats: jest.fn().mockResolvedValue({ ecfProcessing: { waiting: 0 } }) };

    // Reset static last runs
    SchedulerService.lastRuns.contingencyRetry = null;
    SchedulerService.lastRuns.tokenCleanup = null;
    SchedulerService.lastRuns.certificateCheck = null;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminHealthService,
        { provide: PrismaService, useValue: prisma },
        { provide: QueueService, useValue: queueService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test') } },
        { provide: LOCK_REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get<AdminHealthService>(AdminHealthService);
  });

  it('returns healthy when DB and Redis respond', async () => {
    const result = await service.getDetailedHealth();
    expect(result.status).toBe('healthy');
    expect(result.checks.database.status).toBe('ok');
    expect(result.checks.redis.status).toBe('ok');
  });

  it('returns unhealthy when DB fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));
    const result = await service.getDetailedHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.checks.database.status).toBe('error');
    expect(result.checks.database.error).toContain('Connection refused');
  });

  it('returns unhealthy when Redis fails', async () => {
    redis.ping.mockRejectedValue(new Error('Redis down'));
    const result = await service.getDetailedHealth();
    expect(result.status).toBe('unhealthy');
    expect(result.checks.redis.status).toBe('error');
  });

  it('includes scheduler last-run timestamps', async () => {
    const now = new Date();
    SchedulerService.lastRuns.contingencyRetry = now;
    const result = await service.getDetailedHealth();
    expect(result.checks.scheduler.lastContingencyRun).toEqual(now);
  });

  it('includes system info with positive uptime', async () => {
    const result = await service.getDetailedHealth();
    expect(result.checks.system.uptime).toBeGreaterThan(0);
    expect(result.checks.system.version).toBeTruthy();
  });

  it('includes queue stats', async () => {
    const result = await service.getDetailedHealth();
    expect(result.checks.queues).toBeTruthy();
  });
});
