-- FIX 3 (P5): the idempotency key was UNIQUE GLOBALLY, which let one tenant read
-- another tenant's invoice by guessing its key. Make it unique PER TENANT.
-- (Verified beforehand: zero rows would violate the composite unique.)
DROP INDEX "invoices_idempotency_key_key";

CREATE UNIQUE INDEX "invoices_tenant_id_idempotency_key_key"
  ON "invoices" ("tenant_id", "idempotency_key");
