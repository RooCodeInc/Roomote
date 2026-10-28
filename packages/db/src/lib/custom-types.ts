import { customType } from 'drizzle-orm/pg-core';

import { decryptWithKeyGeneration, encryptJSON, encrypt } from './encryption';

/**
 * Pass an already-encrypted value through unchanged when it decrypts with the
 * current key. A value that only decrypts with `ENCRYPTION_KEY_PREVIOUS` is
 * re-encrypted with the current key (same plaintext, same format), so writes
 * during a key rotation never persist new previous-key ciphertext. Returns
 * `null` when the value is not ciphertext under either key.
 */
function passThroughCiphertext(
  value: string,
  isValidPlaintext: (plaintext: string) => boolean,
): string | null {
  if (value.length < 88 || !/^[A-Za-z0-9+/]+=*$/.test(value)) {
    return null;
  }

  try {
    const { plaintext, key } = decryptWithKeyGeneration(value);

    if (!isValidPlaintext(plaintext)) {
      return null;
    }

    return key === 'current' ? value : encrypt(plaintext);
  } catch {
    return null;
  }
}

function isJson(plaintext: string): boolean {
  try {
    JSON.parse(plaintext);
    return true;
  } catch {
    return false;
  }
}

function encryptedJsonToDriver<TData>(
  value: TData | string | null,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  // If it's already an encrypted string (base64 pattern), pass through.
  // This allows updates without re-encryption.
  if (typeof value === 'string') {
    // Our encrypted strings are always at least 88 chars of base64
    // (salt + iv + tag + min data). Plaintext values that only happen to
    // look like ciphertext, such as long hex or base64-safe secrets, fall
    // through and are encrypted.
    const ciphertext = passThroughCiphertext(value, isJson);
    if (ciphertext !== null) {
      return ciphertext;
    }

    // Preserve plaintext strings verbatim, even when they happen to look
    // like JSON scalars such as numeric OAuth client IDs.
    return encryptJSON(value);
  }

  // Otherwise, encrypt the JSON data.
  return encryptJSON(value as TData);
}

function encryptedTextToDriver(value: string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  // If it's already an encrypted string (base64 pattern), pass through.
  // This allows updates without re-encryption.
  if (typeof value === 'string') {
    // Our encrypted strings are always at least 88 chars of base64
    // (salt + iv + tag + min data). Plaintext values that only happen to
    // look like ciphertext, such as long hex or base64-safe secrets, fall
    // through and are encrypted.
    const ciphertext = passThroughCiphertext(value, () => true);
    if (ciphertext !== null) {
      return ciphertext;
    }

    // Otherwise, encrypt the plain text string.
    return encrypt(value);
  }

  return null;
}

/**
 * Whether a Drizzle column was declared with {@link encryptedJson} or
 * {@link encryptedText}. Used by the re-encryption command to find every
 * encrypted column in the schema without a hand-maintained list.
 */
export function isEncryptedColumn(column: unknown): boolean {
  const mapTo = (column as { mapTo?: unknown } | null)?.mapTo;
  return mapTo === encryptedJsonToDriver || mapTo === encryptedTextToDriver;
}

/**
 * Custom encrypted JSON column type for Drizzle ORM.
 *
 * Type behavior:
 * - INSERT: Accepts TData (e.g., Record<string, string>) which gets encrypted.
 * - SELECT: Returns string | null (the encrypted value).
 * - UPDATE: Accepts either TData (to re-encrypt) or string (already encrypted).
 *
 * To decrypt the data, you must explicitly call the decryptSecrets helper function.
 *
 * Example:
 * ```typescript
 * await db.insert(serviceConnections).values({
 *   secrets: { API_KEY: "sk-123" } // Record<string, string>
 * });
 *
 * const connection = await db.query.serviceConnections.findFirst();
 * console.log(connection.secrets); // string: "base64encodedstring..."
 *
 * const decryptedSecrets = await decryptSecrets(connection.secrets);
 * console.log(decryptedSecrets); // { API_KEY: "sk-123" }
 * ```
 */
export function encryptedJson<TData = Record<string, string>>(name: string) {
  return customType<{
    data: string | null;
    driverData: string | null;
    notNull: false;
    default: false;
  }>({
    dataType() {
      return 'text';
    },
    toDriver: encryptedJsonToDriver<TData>,
    fromDriver(value: unknown): string | null {
      if (value === null || value === undefined) {
        return null;
      }

      if (typeof value !== 'string') {
        throw new Error(
          'Expected string value from database for encrypted JSON',
        );
      }

      return value;
    },
  })(name);
}

/**
 * Custom encrypted text column type for Drizzle ORM.
 *
 * Type behavior:
 * - INSERT: Accepts string which gets encrypted.
 * - SELECT: Returns string | null (the encrypted value).
 * - UPDATE: Accepts either string (to encrypt) or already encrypted string (pass through).
 *
 * To decrypt the data, you must explicitly call the decrypt helper function.
 *
 * Example:
 * ```typescript
 * await db.insert(apiKeys).values({
 *   token: "sk-123456789" // plain string
 * });
 *
 * const key = await db.query.apiKeys.findFirst();
 * console.log(key.token); // string: "base64encodedstring..."
 *
 * const decryptedToken = decrypt(key.token);
 * console.log(decryptedToken); // "sk-123456789"
 * ```
 */
export function encryptedText(name: string) {
  return customType<{
    data: string | null;
    driverData: string | null;
    notNull: false;
    default: false;
  }>({
    dataType() {
      return 'text';
    },
    toDriver: encryptedTextToDriver,
    fromDriver(value: unknown): string | null {
      if (value === null || value === undefined) {
        return null;
      }

      if (typeof value !== 'string') {
        throw new Error(
          'Expected string value from database for encrypted text',
        );
      }

      return value;
    },
  })(name);
}
