-- CreateEnum
CREATE TYPE "received_document_status" AS ENUM ('RECEIVED', 'ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'ERROR');

-- CreateTable
CREATE TABLE "received_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "encf" VARCHAR(13) NOT NULL,
    "ecf_type" "EcfType" NOT NULL,
    "emitter_rnc" VARCHAR(11) NOT NULL,
    "emitter_name" VARCHAR(250) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "total_itbis" DECIMAL(18,2),
    "issue_date" TIMESTAMPTZ NOT NULL,
    "status" "received_document_status" NOT NULL DEFAULT 'RECEIVED',
    "arecf_xml" TEXT,
    "arecf_sent_at" TIMESTAMPTZ,
    "arecf_track_id" VARCHAR(100),
    "acecf_xml" TEXT,
    "acecf_sent_at" TIMESTAMPTZ,
    "acecf_track_id" VARCHAR(100),
    "acecf_status" VARCHAR(20),
    "rejection_reason" TEXT,
    "original_xml" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "received_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "received_documents_tenant_id_idx" ON "received_documents"("tenant_id");
CREATE INDEX "received_documents_company_id_idx" ON "received_documents"("company_id");
CREATE UNIQUE INDEX "received_documents_company_id_encf_key" ON "received_documents"("company_id", "encf");

-- AddForeignKey
ALTER TABLE "received_documents" ADD CONSTRAINT "received_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "received_documents" ADD CONSTRAINT "received_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
