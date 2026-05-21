import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Job } from 'bullmq';
import { convertECF32ToRFCE } from 'dgii-ecf';
import { PrismaService } from '../prisma/prisma.service';
import { XmlBuilderService } from '../xml-builder/xml-builder.service';
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

    // Fix 4n: ordering check for credit/debit notes.
    //
    // E33 (Nota de Débito) and E34 (Nota de Crédito) carry a `referenceEncf`
    // pointing at the e-CF they modify. DGII validates that the referenced
    // e-CF was *previously* submitted and accepted; if the modifier arrives
    // first, DGII rejects with code 614 "El eNCF modificado no ha sido
    // emitido" and the rejection is permanent for that submission.
    //
    // When this happens we throw to trigger BullMQ's exponential retry
    // (5s → 10s → 20s → 40s → 80s with hasReference=true, ~155s budget).
    // By the time the retry fires, the referenced e-CF has typically
    // been processed and accepted, and our retry goes through.
    //
    // Fix 4p: if the referenced invoice is NOT yet in our DB, we also
    // throw to retry rather than proceeding. The previous "proceed" branch
    // assumed the missing reference was an externally-issued e-CF (not in
    // our system), but for bulk uploads like the certification Excel, ALL
    // 25 invoices are created within a ~250ms window: E33:1 (row 2) gets
    // its processor job fired before E32:6 (row 3) is even inserted, the
    // FK-style lookup fails, and we send the modifier to DGII prematurely.
    // The retry handles both cases: bulk-upload timing OR truly external
    // reference. In the truly-external case we exhaust retries and let
    // DGII surface the real error.
    if (invoice.referenceEncf) {
      const referenced = await this.prisma.invoice.findFirst({
        where: {
          tenantId,
          companyId,
          encf: invoice.referenceEncf,
        },
        select: { id: true, status: true, encf: true },
      });

      if (!referenced) {
        // Reference not yet in our DB. Could be:
        //   (a) bulk-upload timing — referenced invoice is being inserted
        //       right now in a parallel request and will appear shortly.
        //   (b) truly external e-CF that won't appear at all.
        // We throw to retry: case (a) self-resolves by retry #2 or #3;
        // case (b) exhausts retries and the job fails. DGII would reject
        // (b) with code 614 anyway, so the user sees the same final error.
        const msg = `${invoice.encf} waiting for referenced ${invoice.referenceEncf} (not yet in DB)`;
        this.logger.info(msg);
        throw new Error(msg);
      } else if (referenced.status !== InvoiceStatus.ACCEPTED) {
        // Referenced e-CF is in flight or contingent. Throw to retry; by the
        // next attempt it should be ACCEPTED.
        const msg = `${invoice.encf} waiting for referenced ${invoice.referenceEncf} (status: ${referenced.status})`;
        this.logger.info(msg);
        throw new Error(msg);
      }
      // status === ACCEPTED → proceed
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
        // RFCE flow: derive summary FROM the signed e-CF and submit to FC endpoint.
        //
        // Fix 4j: use dgii-ecf's official `convertECF32ToRFCE` instead of
        // our hand-built `buildRfceXml`. The official flow is:
        //   1. Build E32 e-CF and sign it (already done above, `signedXml`)
        //   2. Convert signed E32 → RFCE (xml2Json → manipulate → json2xml)
        //   3. Sign the RFCE
        //   4. POST to /CerteCF/RecepcionFC
        //
        // Why the previous Fix 4i RFCE rebuild from InvoiceInput failed:
        // DGII responded with a generic "ERROR" HTML page (no diagnostic)
        // for all four E32 < 250K submissions. After comparing my output
        // against `convertECF32ToRFCE`'s implementation, mine had:
        //   - extra `xmlns:xsi`/`xmlns:xsd` on the root <RFCE>
        //   - <CantidadeNCF> tag (not in the library's RFCE shape)
        //   - hand-reassembled <TablaFormasPago> (vs. library's verbatim copy)
        //   - generally different element ordering and quoting from json2xml
        // The library is what MSeller (a certified PSFE) uses successfully;
        // reusing it removes guesswork and matches what DGII validates.
        //
        // Note: convertECF32ToRFCE extracts the CodigoSeguridadeCF from the
        // first 6 digits of the e-CF's <SignatureValue>, so we don't pass
        // securityCode in — it's computed from `signedXml` directly.
        const { xml: rfceXml } = convertECF32ToRFCE(signedXml);

        // Sign the RFCE with the same certificate used for the e-CF.
        const { signedXml: signedRfceXml } = this.signingService.signXml(
          rfceXml, privateKey, certificate,
        );
        this.logger.info(`RFCE signed: ${invoice.encf}`);

        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: { xmlRfce: signedRfceXml },
        });

        // Per DGII p.59: RFCE filename = {RNCEmisor}{eNCF}.xml
        submissionResult = await this.dgiiService.submitRfce(
          signedRfceXml, token, invoice.company.dgiiEnv,
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
      //
      // Fix 4i: RFCE submissions never receive a trackId from DGII (the FC
      // receive endpoint returns the final status synchronously). Encolar
      // un polling para RFCE garantiza el ERROR final tras reintentos
      // ("No trackId disponible y reconciliación DGII falló"). Si el RFCE
      // quedó en SENT/PROCESSING por un error transitorio del parser, lo
      // dejamos en ese estado para revisión manual en vez de hacer polling
      // sin sentido.
      if (
        (newStatus === InvoiceStatus.PROCESSING || newStatus === InvoiceStatus.SENT) &&
        !(isRfce && !submissionResult.trackId)
      ) {
        await this.queueService.enqueueStatusPoll({
          invoiceId,
          tenantId,
          companyId,
          attempt: 1,
        });
        this.logger.info(`${invoice.encf} scheduled for status polling (${newStatus})`);
      } else if (isRfce && !submissionResult.trackId) {
        this.logger.info(`${invoice.encf} is RFCE — skipping status poll (no trackId expected)`);
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
