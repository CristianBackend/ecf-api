/*
  Warnings:

  - Added the required column `approval_datetime` to the `step3_acecf_documents` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "step3_acecf_documents" ADD COLUMN     "approval_datetime" VARCHAR(20) NOT NULL;
