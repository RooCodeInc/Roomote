import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

import { getEncryptionKey } from '@roomote/env';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeEncryptionKey(): string {
  const key = getEncryptionKey();
  const fingerprint = createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 12);

  return `ENCRYPTION_KEY(length=${key.length}, fingerprint=${fingerprint})`;
}

/**
 * Derives a key from the encryption key using scrypt.
 */
function deriveKey(salt: Buffer): Buffer {
  return scryptSync(getEncryptionKey(), salt, KEY_LENGTH);
}

export function encrypt(text: string): string {
  // Generate random salt and IV.
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key from password and salt.
  const key = deriveKey(salt);

  // Create cipher.
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Encrypt the text.
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  // Get the authentication tag.
  const tag = cipher.getAuthTag();

  // Combine salt, iv, tag, and encrypted data.
  const combined = Buffer.concat([salt, iv, tag, encrypted]);

  // Return base64 encoded string.
  return combined.toString('base64');
}

export function decrypt(encryptedText: string): string {
  // Decode from base64.
  const combined = Buffer.from(encryptedText, 'base64');

  // Extract components.
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);

  const tag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
  );

  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  // Derive key from password and salt.
  const key = deriveKey(salt);

  // Create decipher.
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // Decrypt the data.
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function encryptJSON<T>(data: T): string {
  return encrypt(JSON.stringify(data));
}

export function decryptJSON<T>(encryptedText: string): T {
  return JSON.parse(decrypt(encryptedText));
}

export async function decryptSecrets<T = Record<string, string>>(
  encryptedSecrets: string | null | undefined,
): Promise<T | null> {
  if (!encryptedSecrets) {
    return null;
  }

  try {
    return decryptJSON<T>(encryptedSecrets);
  } catch (decryptError) {
    let fallbackValue: T;
    try {
      fallbackValue = JSON.parse(encryptedSecrets) as T;
    } catch (jsonFallbackError) {
      const message =
        `Failed to decrypt secrets: decryptJSON failed (${describeError(decryptError)}); ` +
        `JSON fallback failed (${describeError(jsonFallbackError)}); ` +
        `${describeEncryptionKey()}`;

      console.error(message);
      throw new Error(message);
    }

    // decryptJSON failed but the value parsed as plaintext JSON: the secret is
    // stored unencrypted (e.g. a pre-encryption migration leftover). Warn so it
    // is visible; re-saving the secret encrypts it at rest.
    console.warn(
      `⚠️ Read an unencrypted secret via the plaintext-JSON fallback; ` +
        `re-save it to encrypt at rest. (${describeError(decryptError)}; ${describeEncryptionKey()})`,
    );

    return fallbackValue;
  }
}

export function decryptText(encryptedString: string): string {
  return decrypt(encryptedString);
}
