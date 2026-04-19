-- AlterEnum: InvoiceStatus gains QUEUED (initial state before the async
-- pipeline picks an invoice up). Placed after DRAFT to keep the logical
-- order DRAFT -> QUEUED -> PROCESSING -> SENT -> (ACCEPTED|REJECTED|...).
ALTER TYPE "InvoiceStatus" ADD VALUE 'QUEUED' AFTER 'DRAFT';

-- AlterEnum: WebhookEvent gains three values covering the full lifecycle
-- emitted by the async pipeline: INVOICE_QUEUED (right after create),
-- INVOICE_SUBMITTED (once DGII acknowledges receipt with a TrackId), and
-- INVOICE_CONTINGENCY (when DGII is unreachable and retries are exhausted).
ALTER TYPE "WebhookEvent" ADD VALUE 'INVOICE_QUEUED' AFTER 'INVOICE_CREATED';
ALTER TYPE "WebhookEvent" ADD VALUE 'INVOICE_SUBMITTED' AFTER 'INVOICE_QUEUED';
ALTER TYPE "WebhookEvent" ADD VALUE 'INVOICE_CONTINGENCY' AFTER 'INVOICE_VOIDED';
