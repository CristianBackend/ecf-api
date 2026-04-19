/**
 * CertificatesService integration test — encryption at rest
 *
 * Verifies the cert storage pipeline end-to-end with the new
 * CERT_ENCRYPTION_KEY-backed EncryptionService:
 * - upload() persists AES-256-GCM ciphertext (iv | authTag | ciphertext).
 * - getDecryptedCertificate() round-trips the original .p12 buffer and
 *   passphrase via the same key.
 * - A service instance constructed with a *different* key cannot decrypt,
 *   and the failure surface is a clear error (not a silent truncation).
 */
import { CertificatesService } from './certificates.service';
import { EncryptionService } from '../common/services/encryption.service';
import { buildTestP12, TestP12 } from '../signing/test-fixtures';

type Mock = jest.Mock;

const KEY_A = '1'.repeat(64);
const KEY_B = '2'.repeat(64);

function makePrisma() {
  const state: { cert: any | null } = { cert: null };
  return {
    state,
    company: {
      findFirst: jest.fn(async () => ({
        id: 'company-1',
        tenantId: 'tenant-1',
      })),
    },
    certificate: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => {
        state.cert = { id: 'cert-1', ...data };
        return state.cert;
      }),
      findFirst: jest.fn(async () => state.cert),
    },
  };
}

describe('CertificatesService — encryption at rest', () => {
  let p12: TestP12;

  beforeAll(() => {
    p12 = buildTestP12({ rnc: '00000000000', passphrase: 'pw-test' });
  });

  it('upload → getDecryptedCertificate round-trips the original buffer and passphrase', async () => {
    const encryption = new EncryptionService(KEY_A);
    const prisma = makePrisma();
    const service = new CertificatesService(prisma as any, encryption);

    await service.upload('tenant-1', {
      companyId: 'company-1',
      p12Base64: p12.p12Buffer.toString('base64'),
      passphrase: p12.passphrase,
    } as any);

    // Ensure Prisma actually received ciphertext (not the raw p12)
    const persisted = (prisma.certificate.create as Mock).mock.calls[0][0].data;
    const storedBuffer: Buffer = persisted.encryptedP12;
    expect(Buffer.isBuffer(storedBuffer)).toBe(true);
    expect(storedBuffer.equals(p12.p12Buffer)).toBe(false);

    // Format assertion: [iv(12) | authTag(16) | ciphertext]
    expect(EncryptionService.IV_BYTES).toBe(12);
    expect(EncryptionService.AUTH_TAG_BYTES).toBe(16);
    expect(storedBuffer.length).toBe(12 + 16 + p12.p12Buffer.length);

    // Round-trip via the service
    const { p12Buffer, passphrase } = await service.getDecryptedCertificate(
      'tenant-1',
      'company-1',
    );
    expect(p12Buffer.equals(p12.p12Buffer)).toBe(true);
    expect(passphrase).toBe(p12.passphrase);
  });

  it('a different CERT_ENCRYPTION_KEY cannot decrypt — clear error surface', async () => {
    const keyA = new EncryptionService(KEY_A);
    const prisma = makePrisma();
    const uploader = new CertificatesService(prisma as any, keyA);

    await uploader.upload('tenant-1', {
      companyId: 'company-1',
      p12Base64: p12.p12Buffer.toString('base64'),
      passphrase: p12.passphrase,
    } as any);

    // Swap the encryption key under the same data — simulates rotating the
    // key without re-encrypting.
    const keyB = new EncryptionService(KEY_B);
    const reader = new CertificatesService(prisma as any, keyB);

    await expect(
      reader.getDecryptedCertificate('tenant-1', 'company-1'),
    ).rejects.toThrow(/wrong CERT_ENCRYPTION_KEY|Decryption failed/);
  });
});
