import {
  encrypt,
  decrypt,
  encryptJSON,
  decryptJSON,
  decryptSecrets,
} from '../encryption';

describe('Encryption utilities', () => {
  describe('derived key caching', () => {
    it('reuses the derived key when decrypting the same ciphertext', () => {
      // Every request re-reads the same stored rows; without caching each
      // read pays a fresh scrypt derivation, synchronously.
      const encrypted = encrypt('cached-secret');

      expect(decrypt(encrypted)).toBe('cached-secret');

      const started = performance.now();

      for (let index = 0; index < 20; index += 1) {
        expect(decrypt(encrypted)).toBe('cached-secret');
      }

      // 20 uncached scrypt derivations take hundreds of milliseconds; cached
      // reads are microseconds. The bound is loose so the assertion is about
      // the cache existing, not about machine speed.
      expect(performance.now() - started).toBeLessThan(150);
    });

    it('keeps distinct ciphertexts independent', () => {
      const first = encrypt('first-secret');
      const second = encrypt('second-secret');

      expect(decrypt(first)).toBe('first-secret');
      expect(decrypt(second)).toBe('second-secret');
      expect(decrypt(first)).toBe('first-secret');
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a string correctly', () => {
      const originalText = 'This is a secret message';
      const encrypted = encrypt(originalText);

      // Encrypted text should be different from original.
      expect(encrypted).not.toBe(originalText);

      // Should be base64 encoded.
      expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();

      // Should decrypt back to original.
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(originalText);
    });

    it('should produce different encrypted values for the same input', () => {
      const originalText = 'Same text';
      const encrypted1 = encrypt(originalText);
      const encrypted2 = encrypt(originalText);

      // Due to random salt and IV, encrypted values should be different.
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value.
      expect(decrypt(encrypted1)).toBe(originalText);
      expect(decrypt(encrypted2)).toBe(originalText);
    });

    it('should handle empty strings', () => {
      const originalText = '';
      const encrypted = encrypt(originalText);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(originalText);
    });

    it('should handle special characters and unicode', () => {
      const originalText = '🔐 Special chars: !@#$%^&*() 中文字符';
      const encrypted = encrypt(originalText);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(originalText);
    });

    it('should throw error for invalid encrypted data', () => {
      expect(() => decrypt('invalid-base64')).toThrow();
      expect(() => decrypt('dGVzdA==')).toThrow(); // Valid base64 but not encrypted data.
    });
  });

  describe('encryptJSON/decryptJSON', () => {
    it('should encrypt and decrypt JSON objects', () => {
      const originalData = {
        apiKey: 'sk-1234567890',
        secret: 'my-secret-value',
        nested: {
          value: 'nested-secret',
        },
      };

      const encrypted = encryptJSON(originalData);

      // Should be a string.
      expect(typeof encrypted).toBe('string');

      // Should decrypt back to original object.
      const decrypted = decryptJSON(encrypted);
      expect(decrypted).toEqual(originalData);
    });

    it('should handle Record<string, string> type', () => {
      const secrets: Record<string, string> = {
        API_KEY: 'sk-test-key',
        DATABASE_URL: 'postgres://user:pass@localhost/db',
        JWT_SECRET: 'super-secret-jwt-key',
      };

      const encrypted = encryptJSON(secrets);
      const decrypted = decryptJSON<Record<string, string>>(encrypted);

      expect(decrypted).toEqual(secrets);
      expect(decrypted.API_KEY).toBe('sk-test-key');
      expect(decrypted.DATABASE_URL).toBe('postgres://user:pass@localhost/db');
      expect(decrypted.JWT_SECRET).toBe('super-secret-jwt-key');
    });

    it('should handle null and undefined in objects', () => {
      const data = {
        key1: 'value1',
        key2: null,
        key3: undefined,
      };

      const encrypted = encryptJSON(data);
      const decrypted = decryptJSON(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should handle arrays', () => {
      const data = ['secret1', 'secret2', 'secret3'];

      const encrypted = encryptJSON(data);
      const decrypted = decryptJSON(encrypted);

      expect(decrypted).toEqual(data);
    });

    it('should handle complex nested structures', () => {
      const data = {
        level1: {
          level2: {
            level3: {
              secret: 'deeply-nested-secret',
              array: [1, 2, 3],
              boolean: true,
            },
          },
        },
      };

      const encrypted = encryptJSON(data);
      const decrypted = decryptJSON(encrypted);

      expect(decrypted).toEqual(data);
    });
  });

  describe('decryptSecrets', () => {
    it('should support legacy plaintext JSON values and warn', async () => {
      const plaintext = JSON.stringify({
        OPENAI_API_KEY: 'sk-test-key',
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(
          decryptSecrets<Record<string, string>>(plaintext),
        ).resolves.toEqual({
          OPENAI_API_KEY: 'sk-test-key',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('unencrypted secret'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should include decrypt and fallback details when decryption fails', async () => {
      await expect(
        decryptSecrets('not-encrypted-and-not-json'),
      ).rejects.toThrow(
        /Failed to decrypt secrets: decryptJSON failed .* JSON fallback failed \(.+\); ENCRYPTION_KEY\(length=\d+, fingerprint=[a-f0-9]{12}\)/,
      );
    });
  });
});
