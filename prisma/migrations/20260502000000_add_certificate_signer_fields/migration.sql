-- Migration T9: Add signer identity fields to certificates table
-- Per DGII delegate model: the cert is issued to the natural person (signer),
-- not the company. Store the signer's name, cédula (signerId), optional email
-- (from SAN), and CA name for audit and display purposes.

ALTER TABLE "certificates"
  ADD COLUMN "issuer_name"   VARCHAR(250),
  ADD COLUMN "signer_name"   VARCHAR(250),
  ADD COLUMN "signer_id"     VARCHAR(50),
  ADD COLUMN "signer_email"  VARCHAR(320);
