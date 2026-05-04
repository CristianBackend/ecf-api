-- Tarea 17.4: add must_change_password column to tenants table
-- Set to TRUE for tenants created by an admin (forced password change on first login).
-- Set back to FALSE when the tenant successfully changes their password (17.5).

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;
