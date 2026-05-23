-- CreateEnum
CREATE TYPE "Step3AcecfStatus" AS ENUM ('PENDING', 'BUILDING', 'SIGNING', 'SUBMITTING', 'SENT', 'ACCEPTED', 'REJECTED', 'ERROR');

-- CreateTable
CREATE TABLE "step3_acecf_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "encf" VARCHAR(13) NOT NULL,
    "ecf_type" VARCHAR(3) NOT NULL,
    "emitter_rnc" VARCHAR(11) NOT NULL,
    "receiver_rnc" VARCHAR(11) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "issue_date" DATE NOT NULL,
    "intended_estado" INTEGER NOT NULL,
    "rejection_reason" TEXT,
    "status" "Step3AcecfStatus" NOT NULL DEFAULT 'PENDING',
    "acecf_xml" TEXT,
    "signed_xml" TEXT,
    "track_id" VARCHAR(100),
    "dgii_response" JSONB,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step3_acecf_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step3_acecf_documents_tenant_id_status_idx" ON "step3_acecf_documents"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "step3_acecf_documents_tenant_id_company_id_encf_key" ON "step3_acecf_documents"("tenant_id", "company_id", "encf");
