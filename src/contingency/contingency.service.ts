import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceStatus } from '@prisma/client';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { QueueService } from '../queue/queue.service';
import { DGII_STATUS, FC_FULL_SUBMISSION_THRESHOLD } from '../xml-builder/ecf-types';

/**
 * Contingency Module
 *
 * Handles the scenario when DGII services are unavailable.
 * Per DGII regulations, businesses can continue invoicing in contingency mode
 * and must submit within 72 hours once services are restored.
 */
@Injectable()
export class ContingencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly queueService: QueueService,
    @InjectPinoLogger(ContingencyService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Get all invoices in contingency status.
   */
  async getPendingInvoices(tenantId?: string) {
    const where: any = { status: InvoiceStatus.CONTINGENCY };
    if (tenantId) where.tenantId = tenantId;

    const invoices = await this.prisma.invoice.findMany({
      where,
      include: {
        company: { select: { rnc: true, businessName: true, dgiiEnv: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Add time warnings
    return invoices.map((inv) => {
      const hoursInContingency = Math.floor(
        (Date.now() - inv.createdAt.getTime()) / (1000 * 60 * 60),
      );
      const hoursRemaining = Math.max(0, 72 - hoursInContingency);

      return {
        id: inv.id,
        encf: inv.encf,
        ecfType: inv.ecfType,
        totalAmount: inv.totalAmount,
        company: inv.company,
        createdAt: inv.createdAt,
        hoursInContingency,
        hoursRemaining,
        urgent: hoursRemaining < 12,
        expired: hoursRemaining === 0,
      };
    });
  }

  /**
   * Get contingency statistics for a tenant.
   */
  async getStats(tenantId: string) {
    const [contingencyCount, errorCount, totalToday] = await Promise.all([
      this.prisma.invoice.count({
        where: { tenantId, status: InvoiceStatus.CONTINGENCY },
      }),
      this.prisma.invoice.count({
        where: { tenantId, status: InvoiceStatus.ERROR },
      }),
      this.prisma.invoice.count({
        where: {
          tenantId,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    // Get oldest contingency invoice
    const oldest = await this.prisma.invoice.findFirst({
      where: { tenantId, status: InvoiceStatus.CONTINGENCY },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    const oldestHours = oldest
      ? Math.floor((Date.now() - oldest.createdAt.getTime()) / (1000 * 60 * 60))
      : 0;

    return {
      contingencyCount,
      errorCount,
      totalToday,
      oldestContingencyHours: oldestHours,
      urgentAction: oldestHours > 60, // Less than 12h remaining
    };
  }

  /**
   * Mark an ERROR invoice as CONTINGENCY for retry.
   */
  async markForRetry(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId, status: InvoiceStatus.ERROR },
    });

    if (!invoice) {
      return { message: 'Factura no encontrada o no está en estado ERROR' };
    }

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.CONTINGENCY },
    });

    this.logger.info(`Invoice ${invoiceId} marked for retry (CONTINGENCY)`);
    return { message: 'Factura marcada para reintento', invoiceId };
  }

  /**
   * Bulk mark ERROR invoices as CONTINGENCY.
   */
  async markAllForRetry(tenantId: string) {
    const result = await this.prisma.invoice.updateMany({
      where: { tenantId, status: InvoiceStatus.ERROR },
      data: { status: InvoiceStatus.CONTINGENCY },
    });

    this.logger.info(`${result.count} invoices marked for retry`);
    return { markedCount: result.count };
  }

  /**
   * Process contingency queue — resubmit pending invoices to DGII.
   * Called by cron job or manually via POST /contingency/process.
   */
  async processQueue(tenantId?: string): Promise<{ processed: number; failed: number; remaining: number }> {
    const where: any = { status: InvoiceStatus.CONTINGENCY };
    if (tenantId) where.tenantId = tenantId;

    const pending = await this.prisma.invoice.findMany({
      where,
      include: { company: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    if (pending.length === 0) {
      return { processed: 0, failed: 0, remaining: 0 };
    }

    // Quick DGII health check before processing batch
    try {
      const testInvoice = pending[0];
      const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
        testInvoice.tenantId, testInvoice.companyId,
      );
      const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
      await this.dgiiService.getToken(
        testInvoice.tenantId, testInvoice.companyId,
        privateKey, certificate, testInvoice.company.dgiiEnv,
      );
    } catch (error: any) {
      this.logger.warn(`DGII still unavailable, skipping contingency processing: ${error.message}`);
      const remaining = pending.length;
      return { processed: 0, failed: 0, remaining };
    }

    let processed = 0;
    let failed = 0;
    const CONTINGENCY_LIMIT_MS = 72 * 60 * 60 * 1000; // 72 hours in ms

    for (const invoice of pending) {
      try {
        // Check 72h window per DGII regulations
        const hoursInContingency = Date.now() - invoice.createdAt.getTime();
        if (hoursInContingency > CONTINGENCY_LIMIT_MS) {
          this.logger.warn(
            `Invoice ${invoice.encf} exceeded 72h contingency window — marking as ERROR`,
          );
          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: {
              status: InvoiceStatus.ERROR,
              dgiiMessage: 'Ventana de contingencia de 72 horas excedida. Requiere gestión manual ante DGII.',
            },
          });
          failed++;
          continue;
        }

        // 1. Get certificate
        const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
          invoice.tenantId, invoice.companyId,
        );
        const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);

        // 2. Sign the stored unsigned XML
        if (!invoice.xmlUnsigned) {
          throw new Error('No unsigned XML stored for invoice');
        }
        const { signedXml, securityCode } = this.signingService.signXml(
          invoice.xmlUnsigned, privateKey, certificate,
        );

        // 3. Authenticate with DGII
        const token = await this.dgiiService.getToken(
          invoice.tenantId, invoice.companyId,
          privateKey, certificate, invoice.company.dgiiEnv,
        );

        // 4. Submit to DGII
        // File name per DGII spec: {RNCEmisor}{eNCF}.xml
        const fileName = `${invoice.company.rnc}${invoice.encf}.xml`;
        const isRfce = invoice.ecfType === 'E32' &&
          Number(invoice.totalAmount) < FC_FULL_SUBMISSION_THRESHOLD;

        let result;
        if (isRfce && invoice.xmlRfce) {
          // FC < 250K: submit RFCE summary to fc.dgii.gov.do
          result = await this.dgiiService.submitRfce(
            invoice.xmlRfce, token, invoice.company.dgiiEnv, fileName,
          );
        } else {
          result = await this.dgiiService.submitEcf(
            signedXml, fileName, token, invoice.company.dgiiEnv,
          );
        }

        // 5. Update invoice
        const newStatus = result.status === DGII_STATUS.ACCEPTED ? InvoiceStatus.ACCEPTED
          : result.status === DGII_STATUS.REJECTED ? InvoiceStatus.REJECTED
          : result.status === DGII_STATUS.CONDITIONAL ? InvoiceStatus.CONDITIONAL
          : InvoiceStatus.PROCESSING;

        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: newStatus,
            xmlSigned: signedXml,
            securityCode,
            trackId: result.trackId,
            dgiiResponse: result as any,
            dgiiMessage: result.message,
            dgiiTimestamp: new Date(),
          },
        });

        // Schedule status polling if DGII returned EN_PROCESO
        if (newStatus === InvoiceStatus.PROCESSING) {
          await this.queueService.enqueueStatusPoll({
            invoiceId: invoice.id,
            tenantId: invoice.tenantId,
            companyId: invoice.companyId,
            attempt: 1,
          });
          this.logger.info(`Scheduled status polling for ${invoice.encf} (EN_PROCESO)`);
        }

        this.logger.info(`Contingency resubmit OK: ${invoice.encf} → ${newStatus}`);
        processed++;
      } catch (error: any) {
        this.logger.error(`Contingency resubmit FAILED: ${invoice.encf} — ${error.message}`);

        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: InvoiceStatus.ERROR,
            dgiiMessage: `Contingency retry failed: ${error.message}`,
          },
        });

        failed++;
      }
    }

    const remainingWhere: any = { status: InvoiceStatus.CONTINGENCY };
    if (tenantId) remainingWhere.tenantId = tenantId;
    const remaining = await this.prisma.invoice.count({
      where: remainingWhere,
    });

    this.logger.info(`Contingency batch: ${processed} OK, ${failed} failed, ${remaining} remaining`);
    return { processed, failed, remaining };
  }
}
