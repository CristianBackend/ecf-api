-- CreateEnum
CREATE TYPE "CompanyPlanStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingAlertLevel" AS ENUM ('INFO', 'WARNING', 'CRITICAL', 'BLOCKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApiKeyScope" ADD VALUE 'BILLING_READ';
ALTER TYPE "ApiKeyScope" ADD VALUE 'BILLING_WRITE';

-- CreateTable
CREATE TABLE "company_plans" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "cycle_start_date" TIMESTAMPTZ NOT NULL,
    "cycle_end_date" TIMESTAMPTZ NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "status" "CompanyPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_usages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "cycle_start_date" TIMESTAMPTZ NOT NULL,
    "base_used" INTEGER NOT NULL DEFAULT 0,
    "topup_used" INTEGER NOT NULL DEFAULT 0,
    "total_quota" INTEGER NOT NULL,
    "notified_70" BOOLEAN NOT NULL DEFAULT false,
    "notified_85" BOOLEAN NOT NULL DEFAULT false,
    "notified_95" BOOLEAN NOT NULL DEFAULT false,
    "notified_100" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topup_packs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "invoice_count" INTEGER NOT NULL,
    "price_usd" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topup_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topup_purchases" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "topup_pack_code" TEXT NOT NULL,
    "cycle_start_date" TIMESTAMPTZ NOT NULL,
    "cycle_end_date" TIMESTAMPTZ NOT NULL,
    "invoices_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topup_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_alerts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "level" "BillingAlertLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "percentage" INTEGER NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_plans_company_id_key" ON "company_plans"("company_id");

-- CreateIndex
CREATE INDEX "company_plans_cycle_end_date_status_idx" ON "company_plans"("cycle_end_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_usages_company_id_cycle_start_date_key" ON "company_usages"("company_id", "cycle_start_date");

-- CreateIndex
CREATE UNIQUE INDEX "topup_packs_code_key" ON "topup_packs"("code");

-- CreateIndex
CREATE INDEX "topup_purchases_company_id_cycle_start_date_idx" ON "topup_purchases"("company_id", "cycle_start_date");

-- CreateIndex
CREATE INDEX "billing_alerts_company_id_is_read_idx" ON "billing_alerts"("company_id", "is_read");

-- AddForeignKey
ALTER TABLE "company_plans" ADD CONSTRAINT "company_plans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_plans" ADD CONSTRAINT "company_plans_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "billing_plans"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_usages" ADD CONSTRAINT "company_usages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topup_purchases" ADD CONSTRAINT "topup_purchases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topup_purchases" ADD CONSTRAINT "topup_purchases_topup_pack_code_fkey" FOREIGN KEY ("topup_pack_code") REFERENCES "topup_packs"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
