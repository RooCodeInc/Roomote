import { customType } from 'drizzle-orm/pg-core';

import { decrypt, decryptJSON, encryptJSON, encrypt } from './encryption';

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
    toDriver(value: TData | string | null): string | null {
      if (value === null || value === undefined) {
        return null;
      }

      // If it's already an encrypted string (base64 pattern), pass through.
      // This allows updates without re-encryption.
      if (typeof value === 'string') {
        // Check if it looks like our encrypted format (base64).
        // Our encrypted strings are always at least 88 chars (salt + iv + tag + min data).
        if (value.length >= 88 && /^[A-Za-z0-9+/]+=*$/.test(value)) {
          try {
            decryptJSON(value);
            return value;
          } catch {
            // Fall through and encrypt plaintext values that only happen to
            // look like ciphertext, such as long hex or base64-safe secrets.
          }
        }

        // Preserve plaintext strings verbatim, even when they happen to look
        // like JSON scalars such as numeric OAuth client IDs.
        return encryptJSON(value);
      }

      // Otherwise, encrypt the JSON data.
      return encryptJSON(value as TData);
    },
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
    toDriver(value: string | null): string | null {
      if (value === null || value === undefined) {
        return null;
      }

      // If it's already an encrypted string (base64 pattern), pass through.
      // This allows updates without re-encryption.
      if (typeof value === 'string') {
        // Check if it looks like our encrypted format (base64).
        // Our encrypted strings are always at least 88 chars (salt + iv + tag + min data).
        if (value.length >= 88 && /^[A-Za-z0-9+/]+=*$/.test(value)) {
          try {
            decrypt(value);
            return value;
          } catch {
            // Fall through and encrypt plaintext values that only happen to
            // look like ciphertext, such as long hex or base64-safe secrets.
          }
        }

        // Otherwise, encrypt the plain text string.
        return encrypt(value);
      }

      return null;
    },
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
