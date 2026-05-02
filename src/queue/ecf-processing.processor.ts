import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { XmlBuilderService, EmitterData } from '../xml-builder/xml-builder.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { QueueService } from './queue.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { InvoiceStatus, WebhookEvent } from '@prisma/client';
import { QUEUES } from './queue.constants';
import { FC_FULL_SUBMISSION_THRESHOLD } from '../xml-builder/ecf-types';

export interface EcfProcessingJobData {
  invoiceId: string;
  tenantId: string;
  companyId: string;
}

/**
 * ECF Processing Worker
 *
 * Async pipeline: sign XML → authenticate DGII → submit → schedule status poll
 *
 * Flow:
 * 1. Load invoice + unsigned XML from DB
 * 2. Get certificate (.p12)
 * 3. Sign XML with XMLDSig (enveloped, RSA-SHA256, C14N 1.0) — NOT XAdES.
 *    DGII requires plain W3C XMLDSig; there is no <xades:QualifyingProperties>
 *    block in the signature. See src/signing/signing.service.ts.
 * 4. Authenticate with DGII (semilla/token)
 * 5. Submit signed XML (or RFCE for E32 < 250K)
 * 6. Update invoice status + trackId
 * 7. Schedule status poll job (if IN_PROCESS)
 * 8. Fire webhook event
 *
 * On failure: mark as CONTINGENCY (network) or ERROR (other),
 * with automatic retry via BullMQ backoff.
 */
@Processor(QUEUES.ECF_PROCESSING)
export class EcfProcessingProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly xmlBuilder: XmlBuilderService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly queueService: QueueService,
    private readonly webhooksService: WebhooksService,
    @InjectPinoLogger(EcfProcessingProcessor.name)
    private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<EcfProcessingJobData>): Promise<any> {
    const { invoiceId, tenantId, companyId } = job.data;
    this.logger.info(`Processing job ${job.id} for invoice ${invoiceId}`);

    // 1. Load invoice
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { company: true },
    });

    if (!invoice) {
      this.logger.error(`Invoice ${invoiceId} not found`);
      return { status: 'NOT_FOUND' };
    }

    if (!invoice.xmlUnsigned) {
      this.logger.error(`Invoice ${invoiceId} has no unsigned XML`);
      return { status: 'NO_XML' };
    }

    // Skip if already processed
    if (invoice.status === InvoiceStatus.ACCEPTED || invoice.status === InvoiceStatus.VOIDED) {
      this.logger.warn(`Invoice ${invoiceId} already in final state: ${invoice.status}`);
      return { status: invoice.status };
    }

    try {
      // 2. Get certificate
      const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
        tenantId, companyId,
      );

      // 3. Sign XML
      const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
      const { signedXml, securityCode, signTime } = this.signingService.signXml(
        invoice.xmlUnsigned, privateKey, certificate,
      );

      this.logger.info(`XML signed: ${invoice.encf} | Security: ${securityCode}`);

      // Update with signed data
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          xmlSigned: signedXml,
          securityCode,
          signedAt: signTime,
          status: InvoiceStatus.PROCESSING,
        },
      });

      // 4. Authenticate with DGII
      const token = await this.dgiiService.getToken(
        tenantId, companyId, privateKey, certificate, invoice.company.dgiiEnv,
      );

      // 5. Submit to DGII
      let submissionResult;
      const isRfce = invoice.ecfType === 'E32' &&
        Number(invoice.totalAmount) < FC_FULL_SUBMISSION_THRESHOLD;

      if (isRfce) {
        // RFCE flow: build summary, submit to FC endpoint
        const emitterData: EmitterData = {
          rnc: invoice.company.rnc,
          businessName: invoice.company.businessName,
          tradeName: invoice.company.tradeName || undefined,
          branchCode: invoice.company.branchCode || undefined,
          address: invoice.company.address || undefined,
          municipality: invoice.company.municipality || undefined,
          province: invoice.company.province || undefined,
          economicActivity: invoice.company.economicActivity || undefined,
        };

        // We need totals to build RFCE — recalculate from stored DTO
        const storedMeta = typeof invoice.metadata === 'string'
          ? JSON.parse(invoice.metadata)
          : (invoice.metadata as any) || {};
        const originalDto = storedMeta._originalDto;

        if (!originalDto) {
          throw new Error(`Invoice ${invoiceId} missing _originalDto in metadata — cannot rebuild RFCE`);
        }

        const { totals } = this.xmlBuilder.buildEcfXml(
          originalDto,
          emitterData,
          invoice.encf!,
        );

        const rfceXml = this.xmlBuilder.buildRfceXml(
          originalDto,
          emitterData,
          invoice.encf!,
          totals,
          securityCode,
        );

        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: { xmlRfce: rfceXml },
        });

        // Per DGII p.59: RFCE filename = {RNCEmisor}{eNCF}.xml
        submissionResult = await this.dgiiService.submitRfce(
          rfceXml, token, invoice.company.dgiiEnv,
          `${invoice.company.rnc}${invoice.encf}.xml`,
        );
      } else {
        // Standard flow
        // File name per DGII spec: {RNCEmisor}{eNCF}.xml
        submissionResult = await this.dgiiService.submitEcf(
          signedXml, `${invoice.company.rnc}${invoice.encf}.xml`, token, invoice.company.dgiiEnv,
        );
      }

      // 6. Update with DGII response (trackId in same update to avoid data loss)
      const newStatus = this.mapDgiiStatus(submissionResult.status);

      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: newStatus,
          trackId: submissionResult.trackId,
          dgiiResponse: submissionResult as any,
          dgiiMessage: submissionResult.message,
          dgiiTimestamp: new Date(),
        },
      });

      this.logger.info(`${invoice.encf} → DGII: ${newStatus} | TrackId: ${submissionResult.trackId}`);

      // 7. Fire INVOICE_SUBMITTED when DGII assigned a TrackId (regardless of
      //    the subsequent status). Subscribers use this to record the DGII
      //    acknowledgment distinct from the final accepted/rejected decision.
      if (submissionResult.trackId) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_SUBMITTED, {
          invoiceId,
          encf: invoice.encf,
          trackId: submissionResult.trackId,
          status: newStatus,
        });
      }

      // 8. If IN_PROCESS, schedule status poll
      if (newStatus === InvoiceStatus.PROCESSING || newStatus === InvoiceStatus.SENT) {
        await this.queueService.enqueueStatusPoll({
          invoiceId,
          tenantId,
          companyId,
          attempt: 1,
        });
        this.logger.info(`${invoice.encf} scheduled for status polling (${newStatus})`);
      }

      // 9. Fire webhook for final statuses
      if (newStatus === InvoiceStatus.ACCEPTED) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_ACCEPTED, {
          invoiceId, encf: invoice.encf, trackId: submissionResult.trackId,
        });
      } else if (newStatus === InvoiceStatus.REJECTED) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_REJECTED, {
          invoiceId, encf: invoice.encf, message: submissionResult.message,
        });
      } else if (newStatus === InvoiceStatus.CONDITIONAL) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_CONDITIONAL, {
          invoiceId, encf: invoice.encf, message: submissionResult.message,
        });
      }

      return {
        status: newStatus,
        trackId: submissionResult.trackId,
        encf: invoice.encf,
      };

    } catch (error: any) {
      this.logger.error(`Error processing ${invoice.encf}: ${error.message}`);

      const isNetworkError =
        error.status === 503 ||
        error.message?.includes('DGII') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('ETIMEDOUT');

      const failStatus = isNetworkError ? InvoiceStatus.CONTINGENCY : InvoiceStatus.ERROR;

      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: failStatus,
          dgiiMessage: `[Job ${job.id}] ${error.message}`,
        },
      });

      // Fire webhook for ERROR status (non-network errors only, network will retry)
      if (!isNetworkError) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_ERROR, {
          invoiceId, encf: invoice.encf, error: error.message,
        }).catch(() => {});
      }

      // Network errors: rethrow so BullMQ retries with backoff
      if (isNetworkError) {
        throw error;
      }

      // Non-network errors: don't retry
      return { status: failStatus, error: error.message };
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<EcfProcessingJobData>): void {
    this.logger.info(
      {
        jobId: job.id,
        queue: QUEUES.ECF_PROCESSING,
        attempt: job.attemptsMade + 1,
        invoiceId: job.data.invoiceId,
        tenantId: job.data.tenantId,
      },
      'job started',
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<EcfProcessingJobData>, result: any): void {
    const durationMs =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    this.logger.info(
      {
        jobId: job.id,
        queue: QUEUES.ECF_PROCESSING,
        durationMs,
        invoiceId: job.data.invoiceId,
        outcome: result?.status ?? 'ok',
      },
      'job completed',
    );
  }

  /**
   * Worker failed event — fires after each failed attempt (including retries).
   *
   * Responsibilities:
   * - Emit a structured error log with jobId / queue / duration / error.
   * - Emit the INVOICE_CONTINGENCY webhook, but ONLY once BullMQ has
   *   exhausted its retry budget (`attemptsMade >= opts.attempts`).
   *   Earlier attempts may still succeed on retry; emitting on every
   *   attempt would spam subscribers.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<EcfProcessingJobData>, error: Error): Promise<void> {
    const durationMs =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    this.logger.error(
      {
        jobId: job.id,
        queue: QUEUES.ECF_PROCESSING,
        durationMs,
        invoiceId: job.data.invoiceId,
        attempt: job.attemptsMade,
        err: { message: error.message, stack: error.stack },
      },
      'job failed',
    );

    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    const { invoiceId, tenantId } = job.data;
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { encf: true, status: true },
    });

    if (!invoice || invoice.status !== InvoiceStatus.CONTINGENCY) {
      return;
    }

    await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_CONTINGENCY, {
      invoiceId,
      encf: invoice.encf,
      error: error.message,
      attempts: job.attemptsMade,
    }).catch((err) => {
      this.logger.error(`Failed to emit INVOICE_CONTINGENCY webhook: ${err.message}`);
    });
  }

  private mapDgiiStatus(dgiiStatus: number): InvoiceStatus {
    switch (dgiiStatus) {
      case 1: return InvoiceStatus.ACCEPTED;
      case 2: return InvoiceStatus.REJECTED;
      case 3: return InvoiceStatus.PROCESSING;
      case 4: return InvoiceStatus.CONDITIONAL;
      default: return InvoiceStatus.SENT;
    }
  }
}
