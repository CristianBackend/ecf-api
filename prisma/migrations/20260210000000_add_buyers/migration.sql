-- CreateEnum
CREATE TYPE "buyer_type" AS ENUM ('CONTRIBUYENTE', 'CONSUMIDOR_FINAL', 'GOBIERNO', 'REGIMEN_ESPECIAL', 'EXTRANJERO', 'INFORMAL');

-- CreateTable
CREATE TABLE "buyers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "rnc" VARCHAR(11),
    "name" VARCHAR(250) NOT NULL,
    "commercial_name" VARCHAR(250),
    "buyer_type" "buyer_type" NOT NULL DEFAULT 'CONSUMIDOR_FINAL',
    "email" VARCHAR(320),
    "phone" VARCHAR(20),
    "address" VARCHAR(500),
    "municipality" VARCHAR(100),
    "province" VARCHAR(100),
    "contact_person" VARCHAR(250),

    -- DGII data (auto-filled from lookup)
    "dgii_status" VARCHAR(50),
    "dgii_payment_regime" VARCHAR(50),
    "dgii_economic_activity" TEXT,
    "dgii_is_electronic_invoicer" BOOLEAN DEFAULT false,
    "dgii_last_verified" TIMESTAMPTZ,

    -- Defaults for invoicing
    "default_ecf_type" "EcfType",
    "default_payment_type" INTEGER,
    "notes" TEXT,

    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "buyers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "buyers_tenant_id_idx" ON "buyers"("tenant_id");
CREATE UNIQUE INDEX "buyers_tenant_id_rnc_key" ON "buyers"("tenant_id", "rnc") WHERE "rnc" IS NOT NULL;
CREATE INDEX "buyers_name_idx" ON "buyers"("name");

-- Add buyer_id to invoices (optional FK)
ALTER TABLE "invoices" ADD COLUMN "buyer_id" UUID;
CREATE INDEX "invoices_buyer_id_idx" ON "invoices"("buyer_id");

-- AddForeignKey
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "buyers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
