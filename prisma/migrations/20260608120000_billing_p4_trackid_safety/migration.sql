-- FIX G (P2 billing): idempotency flag so a given invoice's quota consumption
-- is reverted at most once (REJECTED / VOIDED). Defaults to false for all rows.
ALTER TABLE "invoices" ADD COLUMN "usage_reverted" BOOLEAN NOT NULL DEFAULT false;

-- FIX C (P4 resilience): DB-level safety net against a duplicate ENCF being
-- written to two invoice rows. Partial (WHERE encf IS NOT NULL) so multiple
-- NULL-encf draft rows are still allowed. Complements the application-level
-- SELECT ... FOR UPDATE in sequences.service.getNextEncf.
CREATE UNIQUE INDEX "invoices_company_id_ecf_type_encf_key"
  ON "invoices" ("company_id", "ecf_type", "encf")
  WHERE "encf" IS NOT NULL;
