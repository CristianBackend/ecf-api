-- CreateTable
CREATE TABLE "certification_uploads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certification_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification_upload_items" (
    "id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "invoice_id" UUID,
    "row_number" INTEGER NOT NULL,
    "encf" VARCHAR(13),
    "ecf_type" VARCHAR(3) NOT NULL,
    "row_error" VARCHAR(1000),

    CONSTRAINT "certification_upload_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "certification_uploads_tenant_id_idx" ON "certification_uploads"("tenant_id");

-- CreateIndex
CREATE INDEX "certification_upload_items_upload_id_idx" ON "certification_upload_items"("upload_id");

-- AddForeignKey
ALTER TABLE "certification_upload_items" ADD CONSTRAINT "certification_upload_items_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "certification_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
