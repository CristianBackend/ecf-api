-- AlterEnum
ALTER TYPE "WebhookEvent" ADD VALUE 'INVOICE_ERROR';

-- AlterTable
ALTER TABLE "buyers" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "dgii_last_verified" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "branch_code" VARCHAR(20),
ADD COLUMN     "economic_activity" VARCHAR(100);

-- AlterTable
ALTER TABLE "received_documents" ALTER COLUMN "issue_date" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "arecf_sent_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "acecf_sent_at" SET DATA TYPE TIMESTAMP(3);
