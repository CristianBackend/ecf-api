/**
 * One-off script: recalculate security_code for already-signed invoices.
 *
 * Previously generateSecurityCode() applied SHA-256 to the SignatureValue and
 * took 6 hex chars. DGII expects the first 6 characters of the SignatureValue
 * directly (base64). This script reads xml_signed, extracts the SignatureValue,
 * takes the first 6 chars, and updates security_code — without re-signing.
 *
 * Usage (inside the container, with DB env vars set):
 *   npx ts-node -P tsconfig.json src/scripts/recalculate-security-codes.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function extractSignatureValue(signedXml: string): string | null {
  const match = signedXml.match(
    /<(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue>/,
  );
  if (!match) return null;
  return match[1].replace(/\s/g, '');
}

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: {
      encf: { not: null },
      xmlSigned: { not: null },
    },
    select: { id: true, encf: true, securityCode: true, xmlSigned: true },
  });

  console.log(`Found ${invoices.length} signed invoices to check.`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const inv of invoices) {
    const sigValue = extractSignatureValue(inv.xmlSigned!);
    if (!sigValue) {
      console.log(`SKIP  ${inv.encf}: no <SignatureValue> found in xml_signed`);
      errors++;
      continue;
    }

    const correctCode = sigValue.substring(0, 6);

    if (inv.securityCode === correctCode) {
      skipped++;
      continue;
    }

    await prisma.invoice.update({
      where: { id: inv.id },
      data: { securityCode: correctCode },
    });

    console.log(`UPDATE ${inv.encf}: ${inv.securityCode ?? '(null)'} → ${correctCode}`);
    updated++;
  }

  console.log(`\nDone.`);
  console.log(`  Updated : ${updated}`);
  console.log(`  Already correct / skipped : ${skipped}`);
  console.log(`  Errors (no SignatureValue) : ${errors}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
