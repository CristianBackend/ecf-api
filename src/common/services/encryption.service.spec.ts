/**
 * EncryptionService tests
 *
 * Guards the ciphertext layout the rotation script + test fixtures rely on
 * (12-byte IV + 16-byte authTag + ciphertext), and verifies the failure
 * surface for bad keys or tampered payloads.
 */
import { EncryptionService } from './encryption.service';

const KEY_A = 'a'.repeat(64); // 32 bytes of 0xaa
const KEY_B = 'b'.repeat(64); // 32 bytes of 0xbb

describe('EncryptionService', () => {
  describe('key validation', () => {
    it('rejects missing keys', () => {
      const prev = process.env.CERT_ENCRYPTION_KEY;
      delete process.env.CERT_ENCRYPTION_KEY;
      try {
        expect(() => new EncryptionService()).toThrow(/required/);
      } finally {
        if (prev !== undefined) process.env.CERT_ENCRYPTION_KEY = prev;
      }
    });

    it('rejects keys shorter than 64 hex chars', () => {
      expect(() => new EncryptionService('abc')).toThrow(/64 hex/);
    });

    it('rejects non-hex keys', () => {
      expect(() => new EncryptionService('z'.repeat(64))).toThrow(/hex/);
    });

    it('accepts valid 64-char hex keys (lowercase and uppercase)', () => {
      expect(() => new EncryptionService(KEY_A)).not.toThrow();
      expect(() => new EncryptionService('F'.repeat(64))).not.toThrow();
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('round-trips arbitrary binary data', () => {
      const enc = new EncryptionService(KEY_A);
      const plain = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80, 0x10, 0x20]);
      const cipher = enc.encrypt(plain);
      const decoded = enc.decrypt(cipher);
      expect(decoded.equals(plain)).toBe(true);
    });

    it('round-trips UTF-8 strings', () => {
      const enc = new EncryptionService(KEY_A);
      const value = 'whsec_ñ&<>áé👍';
      expect(enc.decryptString(enc.encryptString(value))).toBe(value);
    });

    it('produces a different ciphertext each time (unique IVs)', () => {
      const enc = new EncryptionService(KEY_A);
      const plain = Buffer.from('the quick brown fox', 'utf8');
      const c1 = enc.encrypt(plain);
      const c2 = enc.encrypt(plain);
      expect(c1.equals(c2)).toBe(false);
    });
  });

  describe('ciphertext layout (12-byte IV + 16-byte authTag + ciphertext)', () => {
    it('prefixes with a 12-byte IV and a 16-byte authTag', () => {
      const enc = new EncryptionService(KEY_A);
      const plain = Buffer.from('hello world', 'utf8');
      const cipher = enc.encrypt(plain);

      expect(EncryptionService.IV_BYTES).toBe(12);
      expect(EncryptionService.AUTH_TAG_BYTES).toBe(16);
      // Total length = 12 + 16 + plain.length (GCM doesn't expand ciphertext)
      expect(cipher.length).toBe(12 + 16 + plain.length);
    });
  });

  describe('failure surface', () => {
    it('decrypting with the wrong key fails with a clear error', () => {
      const a = new EncryptionService(KEY_A);
      const b = new EncryptionService(KEY_B);
      const cipher = a.encrypt(Buffer.from('secret payload', 'utf8'));
      expect(() => b.decrypt(cipher)).toThrow(/wrong CERT_ENCRYPTION_KEY/);
    });

    it('decrypting a mutated ciphertext fails (authTag catches tampering)', () => {
      const enc = new EncryptionService(KEY_A);
      const cipher = enc.encrypt(Buffer.from('secret payload', 'utf8'));
      // Flip a bit somewhere in the ciphertext body
      cipher[cipher.length - 1] ^= 0x01;
      expect(() => enc.decrypt(cipher)).toThrow();
    });

    it('rejects payloads too short to contain IV + authTag', () => {
      const enc = new EncryptionService(KEY_A);
      expect(() => enc.decrypt(Buffer.alloc(10))).toThrow(/too short/);
    });
  });
});
