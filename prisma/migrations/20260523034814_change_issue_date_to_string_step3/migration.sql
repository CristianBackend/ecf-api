/*
  Warnings:

  - Changed the type of `issue_date` on the `step3_acecf_documents` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "step3_acecf_documents" DROP COLUMN "issue_date",
ADD COLUMN     "issue_date" VARCHAR(10) NOT NULL;
