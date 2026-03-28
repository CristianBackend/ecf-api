import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES } from './queue.constants';

export interface CertificateCheckJobData {
  /** If provided, only check this tenant. Otherwise check all. */
  tenantId?: string;
}

/**
 * Certificate Check Worker
 *
 * Periodic job (run daily via cron) that checks certificate expiration
 * dates and logs warnings at different severity levels.
 *
 * Thresholds:
 * - 30 days: WARNING
 * - 7 days: CRITICAL
 * - 0 days: EXPIRED (auto-deactivate)
 */
@Processor(QUEUES.CERTIFICATE_CHECK)
export class CertificateCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(CertificateCheckProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<CertificateCheckJobData>): Promise<any> {
    const { tenantId } = job.data;
    this.logger.log('Running certificate expiration check...');

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
      } else if (daysUntilExpiry <= 7) {
        critical.push(info);
        this.logger.warn(
          `CRITICAL: Certificate for ${cert.company.businessName} expires in ${daysUntilExpiry} days`,
        );
      } else if (daysUntilExpiry <= 30) {
        warnings.push(info);
        this.logger.log(
          `WARNING: Certificate for ${cert.company.businessName} expires in ${daysUntilExpiry} days`,
        );
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

    this.logger.log(
      `Certificate check complete: ${result.checked} checked, ` +
      `${result.healthy} healthy, ${result.warnings} warning, ` +
      `${result.critical} critical, ${result.expired} expired`,
    );

    return result;
  }
}
