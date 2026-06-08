-- FIX 1 (resilience): replace the full unique (company_id, ecf_type, is_active)
-- with a PARTIAL unique that only constrains ACTIVE sequences.
--
-- The old index made (company, type, false) unique too, so a company could keep
-- at most ONE inactive (exhausted/expired) sequence per type. Exhausting a 2nd
-- range set is_active=false on a second row → unique violation → the whole
-- emission transaction (getNextEncf) failed. The partial index enforces only
-- "one ACTIVE sequence per (company, type)" and lets unlimited inactive rows
-- (the exhausted-range history) coexist.
DROP INDEX "sequences_company_id_ecf_type_is_active_key";

CREATE UNIQUE INDEX "sequences_company_id_ecf_type_active_key"
  ON "sequences" ("company_id", "ecf_type")
  WHERE "is_active" = true;
