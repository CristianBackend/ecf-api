import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUES } from './queue.constants';
import { EcfProcessingJobData } from './ecf-processing.processor';
import { StatusPollJobData } from './status-poll.processor';
import { CertificateCheckJobData } from './certificate-check.processor';

/**
 * Queue Service — typed enqueue helpers for the three pipeline queues owned
 * by QueueModule.
 *
 * Webhook delivery is NOT exposed here: use WebhooksService.emit(), which is
 * the single public entry-point for emitting events.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUES.ECF_PROCESSING) private readonly ecfQueue: Queue,
    @InjectQueue(QUEUES.ECF_STATUS_POLL) private readonly pollQueue: Queue,
    @InjectQueue(QUEUES.CERTIFICATE_CHECK) private readonly certQueue: Queue,
  ) {}

  /**
   * Enqueue an invoice for async processing (sign + submit to DGII).
   * Uses invoiceId as jobId for deduplication.
   */
  async enqueueEcfProcessing(data: EcfProcessingJobData) {
    const job = await this.ecfQueue.add('process', data, {
      jobId: `ecf-${data.invoiceId}`,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000, // 5s, 10s, 20s
      },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
    });

    this.logger.log(`Enqueued ECF processing: ${job.id} for invoice ${data.invoiceId}`);
    return job;
  }

  /**
   * Enqueue a status poll for an invoice.
   * Uses exponential delay: 30s → 1m → 2m → 5m → 10m → 30m → 1h
   */
  async enqueueStatusPoll(data: StatusPollJobData, delayMs?: number) {
    const attempt = data.attempt || 1;
    const delay = delayMs || this.getPollDelay(attempt);

    const job = await this.pollQueue.add('poll', data, {
      jobId: `poll-${data.invoiceId}-${attempt}`,
      delay,
      attempts: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    this.logger.log(
      `Enqueued status poll #${attempt} for ${data.invoiceId} (delay: ${Math.round(delay / 1000)}s)`,
    );
    return job;
  }

  /**
   * Schedule a certificate expiration check.
   */
  async scheduleCertificateCheck(data: CertificateCheckJobData = {}) {
    const job = await this.certQueue.add('check', data, {
      jobId: `cert-check-${Date.now()}`,
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 },
    });

    this.logger.log(`Certificate check scheduled: ${job.id}`);
    return job;
  }

  async getQueueStats() {
    const [ecf, poll, cert] = await Promise.all([
      this.getStats(this.ecfQueue),
      this.getStats(this.pollQueue),
      this.getStats(this.certQueue),
    ]);

    return { ecfProcessing: ecf, statusPoll: poll, certificateCheck: cert };
  }

  private async getStats(queue: Queue) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  private getPollDelay(attempt: number): number {
    const delays = [
      30_000,
      60_000,
      120_000,
      300_000,
      600_000,
      1_800_000,
    ];
    return delays[Math.min(attempt - 1, delays.length - 1)];
  }
}
