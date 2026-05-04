-- Migration: add dedicated structured columns for E41 vendor, E46 transport/export, E47 beneficiary
-- These columns replace the fragile metadata._originalDto fallback reads in pdf.service.ts.
-- Null for existing rows — backward compat: pdf.service.ts falls back to metadata for old invoices.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "vendor_rnc" VARCHAR(11);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "vendor_name" VARCHAR(250);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "transport_info" JSONB;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "export_info" JSONB;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "foreign_beneficiary_info" JSONB;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "retention_amount" DECIMAL(18, 2);
