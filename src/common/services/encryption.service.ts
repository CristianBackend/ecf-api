import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * AES-256-GCM envelope encryption used for every secret the platform stores
 * at rest: .p12 buffers, .p12 passphrases, and webhook HMAC secrets.
 *
 * The key is read from CERT_ENCRYPTION_KEY (64 hex characters = 32 bytes),
 * independent of JWT_SECRET. Rotating JWT_SECRET therefore never risks
 * irreversibly losing certificate material. Rotating CERT_ENCRYPTION_KEY
 * itself requires re-encrypting every row; see `scripts/rotate-cert-encryption.ts`.
 *
 * Ciphertext layout (produced by {@link encrypt}):
 *
 *     [ iv (12 bytes) | authTag (16 bytes) | ciphertext ... ]
 *
 * 12-byte IV is the NIST-recommended nonce length for GCM; the authTag is
 * the full 16 bytes produced by `crypto.createCipheriv('aes-256-gcm')`.
 */
@Injectable()
export class EncryptionService {
  static readonly IV_BYTES = 12;
  static readonly AUTH_TAG_BYTES = 16;
  static readonly KEY_HEX_CHARS = 64; // 32 bytes

  private readonly key: Buffer;

  constructor(keyHex?: string) {
    const raw = keyHex ?? process.env.CERT_ENCRYPTION_KEY;
    if (!raw) {
      throw new Error(
        'CERT_ENCRYPTION_KEY is required (64 hex chars = 32 bytes).',
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        `CERT_ENCRYPTION_KEY must be exactly ${EncryptionService.KEY_HEX_CHARS} hex characters.`,
      );
    }
    this.key = Buffer.from(raw, 'hex');
  }

  encrypt(data: Buffer): Buffer {
    const iv = crypto.randomBytes(EncryptionService.IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  decrypt(envelope: Buffer): Buffer {
    if (
      envelope.length <
      EncryptionService.IV_BYTES + EncryptionService.AUTH_TAG_BYTES
    ) {
      throw new Error('Encrypted payload too short to contain IV + authTag.');
    }
    const iv = envelope.subarray(0, EncryptionService.IV_BYTES);
    const authTag = envelope.subarray(
      EncryptionService.IV_BYTES,
      EncryptionService.IV_BYTES + EncryptionService.AUTH_TAG_BYTES,
    );
    const ciphertext = envelope.subarray(
      EncryptionService.IV_BYTES + EncryptionService.AUTH_TAG_BYTES,
    );

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err: any) {
      // Turn the opaque OpenSSL `Unsupported state or unable to authenticate
      // data` into something actionable for operators.
      throw new Error(
        `Decryption failed — wrong CERT_ENCRYPTION_KEY or corrupted ciphertext (${err.message}).`,
      );
    }
  }

  encryptString(value: string): string {
    return this.encrypt(Buffer.from(value, 'utf8')).toString('base64');
  }

  decryptString(base64Envelope: string): string {
    return this.decrypt(Buffer.from(base64Envelope, 'base64')).toString('utf8');
  }
}
