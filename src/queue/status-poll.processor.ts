import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, DelayedError } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { DgiiService } from '../dgii/dgii.service';
import { SigningService } from '../signing/signing.service';
import { CertificatesService } from '../certificates/certificates.service';
import { QueueService } from './queue.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { InvoiceStatus, WebhookEvent } from '@prisma/client';
import { QUEUES } from './queue.constants';

export interface StatusPollJobData {
  invoiceId: string;
  tenantId: string;
  companyId: string;
  /** How many times we've polled this invoice */
  attempt?: number;
}

/**
 * ECF Status Poll Worker
 *
 * Polls DGII's QueryStatus endpoint to check if an invoice
 * has been ACCEPTED or REJECTED after submission.
 *
 * Strategy:
 * - Poll with exponential backoff: 30s, 1m, 2m, 5m, 10m, 30m, 1h
 * - Max 20 attempts (~24 hours of polling)
 * - On final status (ACCEPTED/REJECTED), fire webhook
 * - On CONDITIONAL, log and stop (requires manual action)
 */
@Processor(QUEUES.ECF_STATUS_POLL)
export class StatusPollProcessor extends WorkerHost {
  private readonly logger = new Logger(StatusPollProcessor.name);

  /** Max polling attempts before giving up */
  private static readonly MAX_ATTEMPTS = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dgiiService: DgiiService,
    private readonly signingService: SigningService,
    private readonly certificatesService: CertificatesService,
    private readonly queueService: QueueService,
    private readonly webhooksService: WebhooksService,
  ) {
    super();
  }

  async process(job: Job<StatusPollJobData>): Promise<any> {
    const { invoiceId, tenantId, companyId, attempt = 1 } = job.data;
    this.logger.log(`Status poll #${attempt} for invoice ${invoiceId}`);

    // Load invoice
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { company: true },
    });

    if (!invoice) {
      this.logger.error(`Invoice ${invoiceId} not found`);
      return { status: 'NOT_FOUND' };
    }

    // Already in final state
    if (invoice.status === InvoiceStatus.ACCEPTED ||
        invoice.status === InvoiceStatus.REJECTED ||
        invoice.status === InvoiceStatus.VOIDED) {
      this.logger.log(`Invoice ${invoiceId} already final: ${invoice.status}`);
      return { status: invoice.status, final: true };
    }

    if (!invoice.trackId) {
      // I7: Reconciliation by eNCF — try to recover trackId from DGII
      this.logger.warn(`Invoice ${invoiceId} has no trackId, attempting eNCF reconciliation`);
      try {
        const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
          tenantId, companyId,
        );
        const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
        const token = await this.dgiiService.getToken(
          tenantId, companyId, privateKey, certificate, invoice.company.dgiiEnv,
        );
        const trackResult = await this.dgiiService.queryTrackIds(
          invoice.company.rnc, invoice.encf!, token, invoice.company.dgiiEnv,
        );
        const recoveredTrackId = this.extractTrackIdFromResponse(trackResult.message);
        if (recoveredTrackId) {
          await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: { trackId: recoveredTrackId },
          });
          this.logger.log(`Recovered trackId ${recoveredTrackId} for ${invoice.encf} via eNCF reconciliation`);
          // Continue polling with recovered trackId — let BullMQ re-run
          await job.moveToDelayed(Date.now() + 5000, job.token);
          await job.updateData({ ...job.data, attempt: attempt });
          throw new DelayedError();
        }
      } catch (error: any) {
        if (error instanceof DelayedError) throw error;
        this.logger.warn(`eNCF reconciliation failed for ${invoice.encf}: ${error.message}`);
      }
      return { status: 'NO_TRACK_ID' };
    }

    // Max attempts reached
    if (attempt > StatusPollProcessor.MAX_ATTEMPTS) {
      this.logger.warn(`Max polling attempts reached for ${invoice.encf}`);
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          dgiiMessage: `Status polling timed out after ${attempt - 1} attempts. Last status: ${invoice.status}`,
        },
      });
      return { status: 'TIMEOUT', attempts: attempt - 1 };
    }

    try {
      // Authenticate
      const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
        tenantId, companyId,
      );
      const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
      const token = await this.dgiiService.getToken(
        tenantId, companyId, privateKey, certificate, invoice.company.dgiiEnv,
      );

      // Query DGII
      const result = await this.dgiiService.queryStatus(
        invoice.trackId, token, invoice.company.dgiiEnv,
      );

      const newStatus = this.mapDgiiStatus(result.status);
      const isFinal = newStatus === InvoiceStatus.ACCEPTED ||
        newStatus === InvoiceStatus.REJECTED ||
        newStatus === InvoiceStatus.CONDITIONAL;

      // Update if status changed
      if (newStatus !== invoice.status) {
        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            status: newStatus,
            dgiiResponse: result as any,
            dgiiMessage: result.message,
            dgiiTimestamp: new Date(),
          },
        });

        this.logger.log(`${invoice.encf}: ${invoice.status} → ${newStatus}`);
      }

      // If still processing, schedule next poll with backoff
      if (!isFinal) {
        const delayMs = this.getBackoffDelay(attempt);
        this.logger.debug(
          `${invoice.encf} still ${newStatus} (attempt ${attempt}), next poll in ${Math.round(delayMs / 1000)}s`,
        );
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        // Update job data with incremented attempt
        await job.updateData({ ...job.data, attempt: attempt + 1 });
        throw new DelayedError();
      }

      // Fire webhook for final statuses
      const webhookPayload = {
        invoiceId, encf: invoice.encf, trackId: invoice.trackId,
        message: result.message, attempts: attempt,
      };
      if (newStatus === InvoiceStatus.ACCEPTED) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_ACCEPTED, webhookPayload);
      } else if (newStatus === InvoiceStatus.REJECTED) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_REJECTED, webhookPayload);
      } else if (newStatus === InvoiceStatus.CONDITIONAL) {
        await this.webhooksService.emit(tenantId, WebhookEvent.INVOICE_CONDITIONAL, webhookPayload);
      }

      return {
        status: newStatus,
        final: true,
        encf: invoice.encf,
        attempts: attempt,
        dgiiMessage: result.message,
      };

    } catch (error: any) {
      // DelayedError is BullMQ's signal — rethrow silently
      if (error instanceof DelayedError) {
        throw error;
      }

      // Network errors — retry with backoff
      if (error.message?.includes('ECONNREFUSED') ||
          error.message?.includes('ETIMEDOUT')) {
        const delayMs = this.getBackoffDelay(attempt);
        this.logger.debug(`Network error for ${invoice.encf}, retrying in ${Math.round(delayMs / 1000)}s`);
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        await job.updateData({ ...job.data, attempt: attempt + 1 });
        throw new DelayedError();
      }

      this.logger.error(`Poll error for ${invoice.encf}: ${error.message}`);
      return { status: 'ERROR', error: error.message };
    }
  }

  /**
   * Exponential backoff: 30s, 1m, 2m, 5m, 10m, 30m, 1h (capped)
   */
  private getBackoffDelay(attempt: number): number {
    const delays = [
      30_000,     // 30s
      60_000,     // 1m
      120_000,    // 2m
      300_000,    // 5m
      600_000,    // 10m
      1_800_000,  // 30m
      3_600_000,  // 1h
    ];
    return delays[Math.min(attempt - 1, delays.length - 1)];
  }

  private extractTrackIdFromResponse(responseText: string): string | null {
    try {
      const json = JSON.parse(responseText);
      // DGII returns array of trackIds or single object
      const trackId = Array.isArray(json) ? json[0]?.trackId || json[0]?.TrackId : json?.trackId || json?.TrackId;
      return trackId || null;
    } catch {
      const match = responseText.match(/<trackId>([\s\S]*?)<\/trackId>/i);
      return match ? match[1].trim() : null;
    }
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
