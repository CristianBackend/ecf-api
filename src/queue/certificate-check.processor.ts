import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEvent } from '@prisma/client';
import { QUEUES } from './queue.constants';

export interface CertificateCheckJobData {
  /** If provided, only check this tenant. Otherwise check all. */
  tenantId?: string;
}

/**
 * Certificate Check Worker
 *
 * Periodic job (enqueued daily by SchedulerService) that checks certificate
 * expiration dates.
 *
 * Thresholds:
 * - 30 days:  WARNING  → emits CERTIFICATE_EXPIRING webhook
 * - 7 days:   CRITICAL → emits CERTIFICATE_EXPIRING webhook
 * - 0 days:   EXPIRED  → auto-deactivates + emits CERTIFICATE_EXPIRING
 */
@Processor(QUEUES.CERTIFICATE_CHECK)
export class CertificateCheckProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
    @InjectPinoLogger(CertificateCheckProcessor.name)
    private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<CertificateCheckJobData>): Promise<any> {
    const { tenantId } = job.data;
    this.logger.info('Running certificate expiration check...');

    const where: any = { isActive: true };
    if (tenantId) where.tenantId = tenantId;

    const certificates = await this.prisma.certificate.findMany({
      where,
      include: {
        company: { select: { rnc: true, businessName: true } },
      },
    });

    const now = new Date();
    const warnings: any[] = [];
    const critical: any[] = [];
    const expired: any[] = [];

    for (const cert of certificates) {
      const daysUntilExpiry = Math.floor(
        (cert.validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      const info = {
        certificateId: cert.id,
        companyRnc: cert.company.rnc,
        companyName: cert.company.businessName,
        validTo: cert.validTo,
        daysUntilExpiry,
      };

      if (daysUntilExpiry <= 0) {
        expired.push(info);
        await this.prisma.certificate.update({
          where: { id: cert.id },
          data: { isActive: false },
        });
        this.logger.error(
          `EXPIRED: Certificate for ${cert.company.businessName} (${cert.company.rnc})`,
        );
        await this.emitExpiringWebhook(cert.tenantId, info, 'EXPIRED');
      } else if (daysUntilExpiry <= 7) {
        critical.push(info);
        this.logger.warn(
          `CRITICAL: Certificate for ${cert.company.businessName} expires in ${daysUntilExpiry} days`,
        );
        await this.emitExpiringWebhook(cert.tenantId, info, 'CRITICAL');
      } else if (daysUntilExpiry <= 30) {
        warnings.push(info);
        this.logger.info(
          `WARNING: Certificate for ${cert.company.businessName} expires in ${daysUntilExpiry} days`,
        );
        await this.emitExpiringWebhook(cert.tenantId, info, 'WARNING');
      }
    }

    const result = {
      checked: certificates.length,
      healthy: certificates.length - warnings.length - critical.length - expired.length,
      warnings: warnings.length,
      critical: critical.length,
      expired: expired.length,
      details: { warnings, critical, expired },
    };

    this.logger.info(
      `Certificate check complete: ${result.checked} checked, ` +
      `${result.healthy} healthy, ${result.warnings} warning, ` +
      `${result.critical} critical, ${result.expired} expired`,
    );

    return result;
  }

  private async emitExpiringWebhook(
    tenantId: string,
    info: Record<string, any>,
    severity: 'WARNING' | 'CRITICAL' | 'EXPIRED',
  ): Promise<void> {
    await this.webhooksService
      .emit(tenantId, WebhookEvent.CERTIFICATE_EXPIRING, { ...info, severity })
      .catch((err) =>
        this.logger.error(`Failed to emit CERTIFICATE_EXPIRING: ${err.message}`),
      );
  }

  @OnWorkerEvent('active')
  onActive(job: Job<CertificateCheckJobData>): void {
    this.logger.info(
      { jobId: job.id, queue: QUEUES.CERTIFICATE_CHECK },
      'job started',
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<CertificateCheckJobData>, result: any): void {
    const durationMs =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    this.logger.info(
      {
        jobId: job.id,
        queue: QUEUES.CERTIFICATE_CHECK,
        durationMs,
        checked: result?.checked ?? 0,
        warnings: result?.warnings ?? 0,
        critical: result?.critical ?? 0,
        expired: result?.expired ?? 0,
      },
      'job completed',
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<CertificateCheckJobData>, error: Error): void {
    const durationMs =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    this.logger.error(
      {
        jobId: job.id,
        queue: QUEUES.CERTIFICATE_CHECK,
        durationMs,
        err: { message: error.message, stack: error.stack },
      },
      'job failed',
    );
  }
}
