import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class MetricsService {
  private cacheData: unknown = null;
  private cacheAt = 0;
  private readonly TTL_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly config: ConfigService,
    @InjectPinoLogger(MetricsService.name)
    private readonly logger: PinoLogger,
  ) {}

  async getGlobalMetrics() {
    const now = Date.now();
    if (this.cacheData && now - this.cacheAt < this.TTL_MS) {
      return this.cacheData;
    }
    this.cacheData = await this.compute();
    this.cacheAt = now;
    this.logger.debug('Global metrics recomputed and cached');
    return this.cacheData;
  }

  /** Exposed for testing */
  isCacheWarm(): boolean {
    return !!this.cacheData && Date.now() - this.cacheAt < this.TTL_MS;
  }

  private async compute() {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in30Days = new Date(now);
    in30Days.setDate(in30Days.getDate() + 30);

    const [
      tenantTotal, tenantActive, tenantNewThisMonth,
      companyTotal, companyActive,
      invoiceTotal, invoiceToday, invoiceThisMonth,
      invoicesByStatus, invoicesByEcfType,
      certTotal, certActive, certExpiringSoon, certExpired,
      webhookSubs, webhookSubsActive, deliveriesToday, failedToday,
      queues,
    ] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { isActive: true } }),
      this.prisma.tenant.count({ where: { createdAt: { gte: startOfMonth } } }),

      this.prisma.company.count(),
      this.prisma.company.count({ where: { isActive: true } }),

      this.prisma.invoice.count(),
      this.prisma.invoice.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.invoice.count({ where: { createdAt: { gte: startOfMonth } } }),
      this.prisma.invoice.groupBy({ by: ['status'], _count: { status: true } }),
      this.prisma.invoice.groupBy({ by: ['ecfType'], _count: { ecfType: true } }),

      this.prisma.certificate.count(),
      this.prisma.certificate.count({ where: { isActive: true } }),
      this.prisma.certificate.count({ where: { isActive: true, validTo: { gte: now, lte: in30Days } } }),
      this.prisma.certificate.count({ where: { validTo: { lt: now } } }),

      this.prisma.webhookSubscription.count(),
      this.prisma.webhookSubscription.count({ where: { isActive: true } }),
      this.prisma.webhookDelivery.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.webhookDelivery.count({
        where: { createdAt: { gte: startOfDay }, statusCode: { notIn: [200, 201, 202, 204] } },
      }),

      this.queueService.getQueueStats(),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of invoicesByStatus) {
      byStatus[row.status] = row._count.status;
    }

    const byEcfType: Record<string, number> = {};
    for (const row of invoicesByEcfType) {
      byEcfType[row.ecfType] = row._count.ecfType;
    }

    const pkg = require('../../package.json') as { version: string };

    return {
      tenants: { total: tenantTotal, active: tenantActive, newThisMonth: tenantNewThisMonth },
      companies: { total: companyTotal, active: companyActive },
      invoices: {
        total: invoiceTotal,
        today: invoiceToday,
        thisMonth: invoiceThisMonth,
        byStatus,
        byEcfType,
      },
      certificates: {
        total: certTotal,
        active: certActive,
        expiringSoon: certExpiringSoon,
        expired: certExpired,
      },
      webhooks: {
        totalSubscriptions: webhookSubs,
        activeSubscriptions: webhookSubsActive,
        deliveriesToday,
        failedToday,
      },
      queues,
      system: {
        version: pkg.version,
        uptime: process.uptime(),
        nodeEnv: this.config.get('NODE_ENV', 'development'),
        dgiiEnvironment: this.config.get('DGII_ENVIRONMENT', 'DEV'),
      },
    };
  }
}
