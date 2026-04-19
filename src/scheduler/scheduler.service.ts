import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStatus } from '@prisma/client';
import { ContingencyService } from '../contingency/contingency.service';
import { QueueService } from '../queue/queue.service';

/**
 * Scheduler Service
 *
 * Runs periodic tasks:
 * 1. Process contingency queue when DGII is available (5min)
 * 2. Clean up expired DGII tokens (1h)
 * 3. Dispatch a certificate expiration check job (24h) — the actual check
 *    work runs on the CertificateCheckProcessor worker.
 *
 * NOTE: Individual invoice status polling is handled exclusively by
 * BullMQ (StatusPollProcessor) with exponential backoff delays.
 * This scheduler only handles periodic batch tasks.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private contingencyInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private certCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly contingencyService: ContingencyService,
    private readonly queueService: QueueService,
  ) {}

  onModuleInit() {
    this.contingencyInterval = setInterval(() => this.processContingency(), 5 * 60 * 1000);
    this.cleanupInterval = setInterval(() => this.cleanupTokens(), 60 * 60 * 1000);
    this.certCheckInterval = setInterval(() => this.scheduleCertificateCheck(), 24 * 60 * 60 * 1000);

    // Run certificate check once on startup so expiring certificates are
    // noticed without waiting up to 24 hours.
    this.scheduleCertificateCheck();

    this.logger.log('Scheduler started: contingency (5min), cleanup (1hr), cert-check (24hr)');
  }

  onModuleDestroy() {
    if (this.contingencyInterval) clearInterval(this.contingencyInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.certCheckInterval) clearInterval(this.certCheckInterval);
    this.logger.log('Scheduler stopped');
  }

  /**
   * Enqueue a certificate expiration check job. The worker logs + deactivates
   * expired certificates; in Task 3 it will also emit CERTIFICATE_EXPIRING
   * webhooks.
   */
  private async scheduleCertificateCheck() {
    try {
      await this.queueService.scheduleCertificateCheck();
    } catch (error: any) {
      this.logger.error(`Certificate check enqueue error: ${error.message}`);
    }
  }

  /**
   * Process contingency queue.
   */
  private async processContingency() {
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

  /**
   * Clean up expired DGII tokens.
   */
  private async cleanupTokens() {
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
