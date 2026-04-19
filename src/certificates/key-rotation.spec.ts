/**
 * Key-rotation integration test
 *
 * Drives `rotateEncryptionKeys()` against an in-memory Prisma stub that
 * mirrors just enough of the API (findMany/update inside $transaction) to
 * exercise the full flow:
 *   1. Encrypt a cert + passphrase + webhook secret with OLD key.
 *   2. Run the rotator with OLD → NEW.
 *   3. Confirm every row is now decryptable with the NEW key and not with
 *      the OLD key.
 *   4. Confirm an AuditLog entry with action=CERT_KEY_ROTATED was written.
 *   5. Confirm a failure mid-flight rolls back (audit not written).
 */
import {
  rotateEncryptionKeys,
  RotationPrismaClient,
  RotationTx,
} from './key-rotation';
import { EncryptionService } from '../common/services/encryption.service';

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);

interface FakeDb {
  certs: Array<{ id: string; encryptedP12: Buffer; encryptedPass: string }>;
  webhooks: Array<{ id: string; secretEnc: Buffer | null }>;
  auditLogs: any[];
}

function makeStub(db: FakeDb, opts: { failOnWebhookUpdate?: boolean } = {}) {
  const tx: RotationTx = {
    certificate: {
      findMany: jest.fn(async () =>
        db.certs.map((c) => ({ ...c })),
      ) as any,
      update: jest.fn(async ({ where, data }: any) => {
        const target = db.certs.find((c) => c.id === where.id);
        if (!target) throw new Error(`cert ${where.id} not found`);
        target.encryptedP12 = data.encryptedP12;
        target.encryptedPass = data.encryptedPass;
      }) as any,
    },
    webhookSubscription: {
      findMany: jest.fn(async () =>
        db.webhooks
          .filter((w) => w.secretEnc !== null)
          .map((w) => ({ ...w })),
      ) as any,
      update: jest.fn(async ({ where, data }: any) => {
        if (opts.failOnWebhookUpdate) {
          throw new Error('boom: simulated partial-rotation failure');
        }
        const target = db.webhooks.find((w) => w.id === where.id);
        if (!target) throw new Error(`wh ${where.id} not found`);
        target.secretEnc = data.secretEnc;
      }) as any,
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        db.auditLogs.push(data);
      }) as any,
    },
  };
  const prisma: RotationPrismaClient = {
    // True atomic tx: snapshot the DB at the start, and if the callback
    // throws, restore the snapshot (rollback emulation).
    $transaction: async (fn) => {
      const snapshot = JSON.parse(
        JSON.stringify({
          certs: db.certs.map((c) => ({
            ...c,
            encryptedP12: c.encryptedP12.toString('base64'),
          })),
          webhooks: db.webhooks.map((w) => ({
            ...w,
            secretEnc: w.secretEnc ? w.secretEnc.toString('base64') : null,
          })),
          auditLogs: db.auditLogs,
        }),
      );
      try {
        return await fn(tx);
      } catch (err) {
        db.certs = snapshot.certs.map((c: any) => ({
          ...c,
          encryptedP12: Buffer.from(c.encryptedP12, 'base64'),
        }));
        db.webhooks = snapshot.webhooks.map((w: any) => ({
          ...w,
          secretEnc: w.secretEnc ? Buffer.from(w.secretEnc, 'base64') : null,
        }));
        db.auditLogs = snapshot.auditLogs;
        throw err;
      }
    },
  };
  return { prisma, tx };
}

describe('rotateEncryptionKeys', () => {
  it('rotates certificates + webhooks from OLD to NEW and writes an audit log', async () => {
    const oldEnc = new EncryptionService(OLD_KEY);

    const p12Plain = Buffer.from('fake p12 bytes', 'utf8');
    const passPlain = 'p12-passphrase';
    const secretPlain = 'whsec_' + 'c'.repeat(64);

    const db: FakeDb = {
      certs: [
        {
          id: 'cert-1',
          encryptedP12: oldEnc.encrypt(p12Plain),
          encryptedPass: oldEnc.encryptString(passPlain),
        },
      ],
      webhooks: [
        {
          id: 'wh-1',
          secretEnc: oldEnc.encrypt(Buffer.from(secretPlain, 'utf8')),
        },
      ],
      auditLogs: [],
    };

    const { prisma } = makeStub(db);
    const result = await rotateEncryptionKeys(prisma, OLD_KEY, NEW_KEY);

    expect(result).toEqual({ certsRotated: 1, webhooksRotated: 1 });

    // Every row now decrypts with NEW, not OLD
    const newEnc = new EncryptionService(NEW_KEY);
    expect(newEnc.decrypt(db.certs[0].encryptedP12).toString('utf8')).toBe(
      'fake p12 bytes',
    );
    expect(newEnc.decryptString(db.certs[0].encryptedPass)).toBe(passPlain);
    expect(newEnc.decrypt(db.webhooks[0].secretEnc!).toString('utf8')).toBe(
      secretPlain,
    );
    expect(() => oldEnc.decrypt(db.certs[0].encryptedP12)).toThrow();
    expect(() => oldEnc.decrypt(db.webhooks[0].secretEnc!)).toThrow();

    // Audit trail
    expect(db.auditLogs).toHaveLength(1);
    expect(db.auditLogs[0].action).toBe('CERT_KEY_ROTATED');
    expect(db.auditLogs[0].metadata.certsRotated).toBe(1);
    expect(db.auditLogs[0].metadata.webhooksRotated).toBe(1);
  });

  it('skips webhook rows whose secretEnc is null (legacy/needsRegeneration)', async () => {
    const oldEnc = new EncryptionService(OLD_KEY);
    const db: FakeDb = {
      certs: [],
      webhooks: [
        { id: 'legacy', secretEnc: null },
        {
          id: 'new',
          secretEnc: oldEnc.encrypt(Buffer.from('plaintext', 'utf8')),
        },
      ],
      auditLogs: [],
    };
    const { prisma } = makeStub(db);
    const result = await rotateEncryptionKeys(prisma, OLD_KEY, NEW_KEY);
    expect(result.webhooksRotated).toBe(1);
    expect(db.webhooks[0].secretEnc).toBeNull();
  });

  it('rolls back (no audit row, no partial writes) when any row update fails', async () => {
    const oldEnc = new EncryptionService(OLD_KEY);
    const originalCertCiphertext = oldEnc.encrypt(Buffer.from('x', 'utf8'));
    const originalCertPass = oldEnc.encryptString('pw');
    const db: FakeDb = {
      certs: [
        {
          id: 'cert-1',
          encryptedP12: originalCertCiphertext,
          encryptedPass: originalCertPass,
        },
      ],
      webhooks: [
        {
          id: 'wh-1',
          secretEnc: oldEnc.encrypt(Buffer.from('s', 'utf8')),
        },
      ],
      auditLogs: [],
    };

    const { prisma } = makeStub(db, { failOnWebhookUpdate: true });

    await expect(
      rotateEncryptionKeys(prisma, OLD_KEY, NEW_KEY),
    ).rejects.toThrow(/simulated/);

    // Rollback: audit log is empty AND the cert row is back to its OLD ciphertext
    expect(db.auditLogs).toHaveLength(0);
    expect(db.certs[0].encryptedP12.equals(originalCertCiphertext)).toBe(true);
    expect(db.certs[0].encryptedPass).toBe(originalCertPass);
  });

  it('refuses to run when OLD and NEW keys are identical', async () => {
    const db: FakeDb = { certs: [], webhooks: [], auditLogs: [] };
    const { prisma } = makeStub(db);
    await expect(
      rotateEncryptionKeys(prisma, OLD_KEY, OLD_KEY),
    ).rejects.toThrow(/must differ/);
  });
});
