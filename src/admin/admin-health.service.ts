import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { LOCK_REDIS_CLIENT } from '../common/services/distributed-lock.service';
import { SchedulerService } from '../scheduler/scheduler.service';

type CheckStatus = 'ok' | 'error';

@Injectable()
export class AdminHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly config: ConfigService,
    @Inject(LOCK_REDIS_CLIENT) private readonly redis: any,
  ) {}

  async getDetailedHealth() {
    const [db, redisCheck, queues] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.queueService.getQueueStats().catch(() => null),
    ]);

    const checks = { database: db, redis: redisCheck, queues, scheduler: this.getSchedulerStatus() };

    const anyError = db.status === 'error' || redisCheck.status === 'error';
    const anyDegraded = db.responseTimeMs > 1000 || redisCheck.responseTimeMs > 1000;
    const status = anyError ? 'unhealthy' : anyDegraded ? 'degraded' : 'healthy';

    const mem = process.memoryUsage();
    const pkg = require('../../package.json') as { version: string };

    return {
      status,
      timestamp: new Date(),
      checks: {
        ...checks,
        system: {
          memoryUsage: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external },
          uptime: process.uptime(),
          version: pkg.version,
          nodeEnv: this.config.get('NODE_ENV', 'development'),
        },
      },
    };
  }

  private async checkDatabase(): Promise<{ status: CheckStatus; responseTimeMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', responseTimeMs: Date.now() - t0 };
    } catch (e: any) {
      return { status: 'error', responseTimeMs: Date.now() - t0, error: e.message };
    }
  }

  private async checkRedis(): Promise<{ status: CheckStatus; responseTimeMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.redis.ping();
      return { status: 'ok', responseTimeMs: Date.now() - t0 };
    } catch (e: any) {
      return { status: 'error', responseTimeMs: Date.now() - t0, error: e.message };
    }
  }

  private getSchedulerStatus() {
    return {
      lastContingencyRun:    SchedulerService.lastRuns.contingencyRetry,
      lastTokenCleanup:      SchedulerService.lastRuns.tokenCleanup,
      lastCertificateCheck:  SchedulerService.lastRuns.certificateCheck,
    };
  }
}
