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
import { XsdValidationService } from '../validation/xsd-validation.service';
import { InvoiceStatus, WebhookEvent } from '@prisma/client';
import { QUEUES } from './queue.constants';
import { ECF_TYPE_CODES } from '../xml-builder/ecf-types';

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
 * 3. Sign XML with XMLDSig — inserts FechaHoraFirma then computes Signature.
 *    DGII requires plain W3C XMLDSig (not XAdES). See signing.service.ts.
 * 3b. Validate signed XML against DGII XSD (FechaHoraFirma now present).
 *     Failure → status ERROR, no DGII call, no retry.
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
    private readonly xsdValidation: XsdValidationService,
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

      // Save signed data now — preserved even if XSD validation fails below
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          xmlSigned: signedXml,
          securityCode,
          signedAt: signTime,
          status: InvoiceStatus.PROCESSING,
        },
      });

      // 3b. Validate signed XML against DGII XSD.
      // Must run post-sign: FechaHoraFirma (minOccurs=1) is only present after signXml().
      if (this.xsdValidation.isAvailable()) {
        const typeCode = ECF_TYPE_CODES[invoice.ecfType as keyof typeof ECF_TYPE_CODES];
        const xsdResult = await this.xsdValidation.validateXml(signedXml, typeCode);
        if (!xsdResult.valid) {
          const errorMsg = xsdResult.errors.slice(0, 3).join('; ');
          this.logger.error(`XSD validation failed for ${invoice.encf}: ${errorMsg}`);
          await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: InvoiceStatus.ERROR, dgiiMessage: `XSD validation failed: ${errorMsg}` },
          });
          await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_ERROR, {
            invoiceId, encf: invoice.encf, error: `XSD validation failed: ${errorMsg}`,
          }).catch(() => {});
          return { status: InvoiceStatus.ERROR, error: errorMsg };
        }
        this.logger.info(`XSD validation passed for ${invoice.encf} (${xsdResult.schema})`);
      } else {
        this.logger.warn(`XSD validation unavailable for ${invoice.encf} — xmllint not installed`);
      }

      // 4. Authenticate with DGII
      const token = await this.dgiiService.getToken(
        tenantId, companyId, privateKey, certificate, invoice.company.dgiiEnv,
      );

      // 5. Submit to DGII
      let submissionResult;
      // FIX 2: use the pre-computed flag stored at invoice creation time instead
      // of re-evaluating Number(invoice.totalAmount), which can drift from the
      // original Decimal value due to floating-point coercion.
      const isRfce = invoice.isRfce;

      if (isRfce) {
        // RFCE flow: build summary, submit to FC endpoint

        // We need totals to build RFCE — recalculate from stored DTO
        const storedMeta = typeof invoice.metadata === 'string'
          ? JSON.parse(invoice.metadata)
          : (invoice.metadata as any) || {};
        const originalDto = storedMeta._originalDto;

        if (!originalDto) {
          throw new Error(`Invoice ${invoiceId} missing _originalDto in metadata — cannot rebuild RFCE`);
        }

        // Apply emitterOverride from stored DTO (for CERT/DEV — set de pruebas DGII)
        // When override is present, NO fallback to company for optional fields:
        // the Excel set is the absolute truth for cert (DGII matches exact values).
        const ovr = originalDto?.emitterOverride;
        const emitterData: EmitterData = ovr
          ? {
              rnc: invoice.company.rnc,
              businessName: ovr.businessName ?? invoice.company.businessName,
              tradeName: ovr.tradeName,
              branchCode: ovr.branchCode,
              address: ovr.address ?? invoice.company.address ?? undefined,
              municipality: ovr.municipality,
              province: ovr.province,
              phones: ovr.phones,
              email: ovr.email,
              website: ovr.website,
              economicActivity: ovr.economicActivity,
              vendorCode: ovr.vendorCode,
              internalInvoiceNumber: ovr.internalInvoiceNumber,
              internalOrderNumber: ovr.internalOrderNumber,
              salesZone: ovr.salesZone,
              salesRoute: ovr.salesRoute,
              additionalInfo: ovr.additionalEmitterInfo,
            }
          : {
              rnc: invoice.company.rnc,
              businessName: invoice.company.businessName,
              tradeName: invoice.company.tradeName ?? undefined,
              branchCode: invoice.company.branchCode ?? undefined,
              address: invoice.company.address ?? undefined,
              municipality: invoice.company.municipality ?? undefined,
              province: invoice.company.province ?? undefined,
              economicActivity: invoice.company.economicActivity ?? undefined,
            };

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
