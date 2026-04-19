/**
 * CLI: rotate CERT_ENCRYPTION_KEY.
 *
 * Reads `CERT_ENCRYPTION_KEY_OLD` and `CERT_ENCRYPTION_KEY_NEW` from the
 * environment, re-encrypts every certificate + webhook secret, and records
 * an audit log row — all within a single Prisma transaction.
 *
 * Usage:
 *     CERT_ENCRYPTION_KEY_OLD=<old 64-hex>  \
 *     CERT_ENCRYPTION_KEY_NEW=<new 64-hex>  \
 *     npx ts-node scripts/rotate-cert-encryption.ts
 *
 * After the script succeeds, deploy the application with the NEW key set as
 * `CERT_ENCRYPTION_KEY` and retire the OLD one.
 */
import { PrismaClient } from '@prisma/client';
import { rotateEncryptionKeys } from '../src/certificates/key-rotation';

async function main() {
  const oldKey = process.env.CERT_ENCRYPTION_KEY_OLD;
  const newKey = process.env.CERT_ENCRYPTION_KEY_NEW;

  if (!oldKey || !/^[0-9a-fA-F]{64}$/.test(oldKey)) {
    console.error('[rotate-cert-encryption] CERT_ENCRYPTION_KEY_OLD must be 64 hex characters (32 bytes).');
    process.exit(1);
  }
  if (!newKey || !/^[0-9a-fA-F]{64}$/.test(newKey)) {
    console.error('[rotate-cert-encryption] CERT_ENCRYPTION_KEY_NEW must be 64 hex characters (32 bytes).');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const result = await rotateEncryptionKeys(prisma as any, oldKey, newKey, {
      auditActor: 'rotate-cert-encryption-script',
    });
    console.log(
      `[rotate-cert-encryption] ✅ Rotation complete: ` +
        `${result.certsRotated} certificates, ${result.webhooksRotated} webhooks.`,
    );
    console.log(
      '[rotate-cert-encryption] Next step: redeploy with CERT_ENCRYPTION_KEY ' +
        'set to the NEW value and retire CERT_ENCRYPTION_KEY_OLD.',
    );
  } catch (err: any) {
    console.error(`[rotate-cert-encryption] ❌ Rotation failed (transaction rolled back): ${err.message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
