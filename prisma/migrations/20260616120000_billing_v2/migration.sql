-- CreateEnum
CREATE TYPE "BillingModelType" AS ENUM ('PER_EMISSION');

-- AlterEnum
BEGIN;
CREATE TYPE "CompanyPlanStatus_new" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');
ALTER TABLE "company_plans" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "company_plans" ALTER COLUMN "status" TYPE "CompanyPlanStatus_new" USING ("status"::text::"CompanyPlanStatus_new");
ALTER TYPE "CompanyPlanStatus" RENAME TO "CompanyPlanStatus_old";
ALTER TYPE "CompanyPlanStatus_new" RENAME TO "CompanyPlanStatus";
DROP TYPE "CompanyPlanStatus_old";
ALTER TABLE "company_plans" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- DropForeignKey
ALTER TABLE "billing_alerts" DROP CONSTRAINT "billing_alerts_company_id_fkey";

-- DropForeignKey
ALTER TABLE "monthly_usages" DROP CONSTRAINT "monthly_usages_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "monthly_usages" DROP CONSTRAINT "monthly_usages_tenant_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_plans" DROP CONSTRAINT "tenant_plans_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant_plans" DROP CONSTRAINT "tenant_plans_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "topup_purchases" DROP CONSTRAINT "topup_purchases_company_id_fkey";

-- DropForeignKey
ALTER TABLE "topup_purchases" DROP CONSTRAINT "topup_purchases_topup_pack_code_fkey";

-- AlterTable
ALTER TABLE "billing_plans" DROP COLUMN "included_invoices",
ADD COLUMN     "type" "BillingModelType" NOT NULL DEFAULT 'PER_EMISSION';

-- AlterTable
ALTER TABLE "company_usages" DROP COLUMN "base_used",
DROP COLUMN "notified_100",
DROP COLUMN "notified_70",
DROP COLUMN "notified_85",
DROP COLUMN "notified_95",
DROP COLUMN "topup_used",
DROP COLUMN "total_quota",
ADD COLUMN     "accepted_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "usage_reverted",
ADD COLUMN     "usage_counted" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "billing_alerts";

-- DropTable
DROP TABLE "monthly_usages";

-- DropTable
DROP TABLE "tenant_plans";

-- DropTable
DROP TABLE "topup_packs";

-- DropTable
DROP TABLE "topup_purchases";

-- DropEnum
DROP TYPE "BillingAlertLevel";

-- DropEnum
DROP TYPE "TenantPlanStatus";

-- CreateTable
CREATE TABLE "pricing_tiers" (
    "id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "from_qty" INTEGER NOT NULL,
    "to_qty" INTEGER,
    "price_per_emission" DECIMAL(18,4),
    "requires_quote" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_tiers_plan_code_sort_order_idx" ON "pricing_tiers"("plan_code", "sort_order");

-- AddForeignKey
ALTER TABLE "pricing_tiers" ADD CONSTRAINT "pricing_tiers_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "billing_plans"("code") ON DELETE CASCADE ON UPDATE CASCADE;

