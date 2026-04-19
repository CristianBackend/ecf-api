/**
 * Key-rotation helper for CERT_ENCRYPTION_KEY.
 *
 * Decrypts every `certificates.encryptedP12` / `certificates.encryptedPass`
 * and every `webhook_subscriptions.secretEnc` with `oldKey`, then re-encrypts
 * them with `newKey`. All work happens inside a single Prisma transaction so
 * a failure halfway through rolls back every row.
 *
 * Invoked from `scripts/rotate-cert-encryption.ts` (and tested in isolation
 * in `key-rotation.spec.ts`, which uses a hand-rolled tx stub instead of a
 * real database).
 */
import { EncryptionService } from '../common/services/encryption.service';

/**
 * The minimal Prisma surface the rotator touches, so tests can provide a
 * plain in-memory stub without spinning up a DB.
 */
export interface RotationPrismaClient {
  $transaction<T>(fn: (tx: RotationTx) => Promise<T>): Promise<T>;
}

export interface RotationTx {
  certificate: {
    findMany(args?: {
      select?: {
        id?: boolean;
        encryptedP12?: boolean;
        encryptedPass?: boolean;
      };
    }): Promise<
      Array<{
        id: string;
        encryptedP12: Buffer | Uint8Array;
        encryptedPass: string;
      }>
    >;
    update(args: {
      where: { id: string };
      data: { encryptedP12: Buffer; encryptedPass: string };
    }): Promise<unknown>;
  };
  webhookSubscription: {
    findMany(args?: any): Promise<
      Array<{ id: string; secretEnc: Buffer | Uint8Array | null }>
    >;
    update(args: {
      where: { id: string };
      data: { secretEnc: Buffer };
    }): Promise<unknown>;
  };
  auditLog: {
    create(args: { data: any }): Promise<unknown>;
  };
}

export interface RotationResult {
  certsRotated: number;
  webhooksRotated: number;
}

export interface RotateOptions {
  /**
   * Tenant ID written into the audit log row. System-level rotations are
   * recorded under the nil UUID by convention; callers can pass a specific
   * operator tenant if they prefer.
   */
  auditTenantId?: string;
  /** Actor string written into the audit log. */
  auditActor?: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export async function rotateEncryptionKeys(
  prisma: RotationPrismaClient,
  oldKeyHex: string,
  newKeyHex: string,
  options: RotateOptions = {},
): Promise<RotationResult> {
  if (oldKeyHex === newKeyHex) {
    throw new Error(
      'CERT_ENCRYPTION_KEY_OLD and CERT_ENCRYPTION_KEY_NEW must differ.',
    );
  }
  const oldEnc = new EncryptionService(oldKeyHex);
  const newEnc = new EncryptionService(newKeyHex);

  return prisma.$transaction(async (tx) => {
    const certs = await tx.certificate.findMany({
      select: { id: true, encryptedP12: true, encryptedPass: true },
    });

    for (const cert of certs) {
      const p12Plain = oldEnc.decrypt(Buffer.from(cert.encryptedP12));
      const passPlain = oldEnc.decryptString(cert.encryptedPass);
      await tx.certificate.update({
        where: { id: cert.id },
        data: {
          encryptedP12: newEnc.encrypt(p12Plain),
          encryptedPass: newEnc.encryptString(passPlain),
        },
      });
    }

    // Only rows that actually hold an encrypted secret are rotated; legacy
    // rows with needsRegeneration=true will be reissued by their owners.
    const webhooks = await tx.webhookSubscription.findMany({
      where: { secretEnc: { not: null } },
      select: { id: true, secretEnc: true },
    });

    for (const wh of webhooks) {
      if (!wh.secretEnc) continue;
      const plain = oldEnc.decrypt(Buffer.from(wh.secretEnc));
      await tx.webhookSubscription.update({
        where: { id: wh.id },
        data: { secretEnc: newEnc.encrypt(plain) },
      });
    }

    await tx.auditLog.create({
      data: {
        tenantId: options.auditTenantId ?? NIL_UUID,
        entityType: 'system',
        entityId: 'cert-encryption-key',
        action: 'CERT_KEY_ROTATED',
        actor: options.auditActor ?? 'rotate-cert-encryption-script',
        metadata: {
          certsRotated: certs.length,
          webhooksRotated: webhooks.length,
          rotatedAt: new Date().toISOString(),
        },
      },
    });

    return { certsRotated: certs.length, webhooksRotated: webhooks.length };
  });
}
