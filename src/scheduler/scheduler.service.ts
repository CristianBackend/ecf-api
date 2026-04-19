import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStatus } from '@prisma/client';
import { ContingencyService } from '../contingency/contingency.service';
import { QueueService } from '../queue/queue.service';
import { DistributedLockService } from '../common/services/distributed-lock.service';

/**
 * Scheduler Service
 *
 * Runs periodic tasks using `@nestjs/schedule`. Each job is wrapped in a
 * Redis-backed distributed lock so only one replica actually does the work
 * per tick — multiple pods all run the schedule, but they compete for the
 * lock and only one wins. Lock TTLs are set generously above the expected
 * job duration so if the holder dies mid-run the lock expires and the next
 * tick can recover.
 *
 * Jobs:
 * 1. contingencyRetry — every 5 minutes. Pushes CONTINGENCY invoices
 *    through ContingencyService.processQueue().
 * 2. tokenCleanup — every hour. Deletes expired DgiiToken rows.
 * 3. certificateExpiryCheck — every day at 02:00 (server TZ). Enqueues a
 *    CERTIFICATE_CHECK job on BullMQ; the actual work runs on the
 *    CertificateCheckProcessor.
 *
 * Individual invoice status polling remains exclusive to the BullMQ
 * StatusPollProcessor with exponential backoff — this file only owns the
 * periodic batch work.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  // Generous TTLs: bigger than the worst-case job duration we've measured so
  // a slow run doesn't start releasing its lock under someone else.
  private static readonly CONTINGENCY_LOCK_TTL_MS = 10 * 60 * 1000; // 10min
  private static readonly TOKEN_CLEANUP_LOCK_TTL_MS = 5 * 60 * 1000; // 5min
  private static readonly CERT_CHECK_LOCK_TTL_MS = 30 * 60 * 1000; // 30min

  constructor(
    private readonly prisma: PrismaService,
    private readonly contingencyService: ContingencyService,
    private readonly queueService: QueueService,
    private readonly lock: DistributedLockService,
  ) {}

  onModuleInit() {
    // Boot-time kick so a freshly deployed pod doesn't wait up to 24h to
    // notice expiring certificates. The lock keeps this safe even when
    // every replica boots in parallel.
    this.scheduleCertificateCheck().catch((err) =>
      this.logger.error(`Boot-time cert check failed: ${err.message}`),
    );
    this.logger.log(
      'Scheduler started: contingency (5min), tokens (1hr), cert-check (daily 02:00)',
    );
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'contingency-retry' })
  async contingencyRetry(): Promise<void> {
    await this.lock.withLock(
      'scheduler:contingency-retry',
      SchedulerService.CONTINGENCY_LOCK_TTL_MS,
      () => this.processContingency(),
    );
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'token-cleanup' })
  async tokenCleanup(): Promise<void> {
    await this.lock.withLock(
      'scheduler:token-cleanup',
      SchedulerService.TOKEN_CLEANUP_LOCK_TTL_MS,
      () => this.cleanupTokens(),
    );
  }

  /**
   * Every day at 02:00 (server timezone) so cert-expiry checks don't pile
   * on top of business-hours traffic.
   */
  @Cron('0 2 * * *', { name: 'certificate-expiry-check' })
  async certificateExpiryCheck(): Promise<void> {
    await this.lock.withLock(
      'scheduler:certificate-expiry-check',
      SchedulerService.CERT_CHECK_LOCK_TTL_MS,
      () => this.scheduleCertificateCheck(),
    );
  }

  // ============================================================
  // job bodies
  // ============================================================

  private async scheduleCertificateCheck(): Promise<void> {
    try {
      await this.queueService.scheduleCertificateCheck();
    } catch (error: any) {
      this.logger.error(`Certificate check enqueue error: ${error.message}`);
    }
  }

  private async processContingency(): Promise<void> {
    try {
      const count = await this.prisma.invoice.count({
        where: { status: InvoiceStatus.CONTINGENCY },
      });
      if (count === 0) return;

      this.logger.debug(`Processing ${count} contingency invoice(s)...`);
      const result = await this.contingencyService.processQueue();

      if (result.processed > 0 || result.failed > 0) {
        this.logger.log(
          `Contingency: ${result.processed} OK, ${result.failed} failed, ${result.remaining} remaining`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Contingency cycle error: ${error.message}`);
    }
  }

  private async cleanupTokens(): Promise<void> {
    try {
      const result = await this.prisma.dgiiToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        this.logger.debug(`Cleaned ${result.count} expired DGII token(s)`);
      }
    } catch (error: any) {
      this.logger.error(`Token cleanup error: ${error.message}`);
    }
  }
}
