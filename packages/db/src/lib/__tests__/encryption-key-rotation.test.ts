import {
  resetSecretProvider,
  setSecretProvider,
  type SecretName,
} from '@roomote/env';

import { userApiKeys } from '../../schema';
import {
  decrypt,
  decryptJSON,
  decryptSecrets,
  decryptWithKeyGeneration,
  encrypt,
  encryptJSON,
} from '../encryption';

const OLD_KEY = 'old-encryption-key-0000000000000000';
const NEW_KEY = 'new-encryption-key-1111111111111111';
const OTHER_KEY = 'other-encryption-key-22222222222222';

function useKeys(keys: Partial<Record<SecretName, string>>) {
  setSecretProvider({ getSecret: (name) => keys[name] });
}

function encryptWith(key: string, text: string): string {
  useKeys({ ENCRYPTION_KEY: key });
  const encrypted = encrypt(text);
  resetSecretProvider();
  return encrypted;
}

function errorFrom(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}

describe('encryption key rotation', () => {
  afterEach(() => {
    resetSecretProvider();
  });

  it('decrypts current-key values without consulting the previous key', () => {
    const encrypted = encryptWith(NEW_KEY, 'current-secret');

    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });

    expect(decryptWithKeyGeneration(encrypted)).toEqual({
      plaintext: 'current-secret',
      key: 'current',
    });
    expect(decrypt(encrypted)).toBe('current-secret');
  });

  it('falls back to the previous key for values written before rotation', () => {
    const encrypted = encryptWith(OLD_KEY, 'pre-rotation-secret');
    const encryptedJson = (() => {
      useKeys({ ENCRYPTION_KEY: OLD_KEY });
      const value = encryptJSON({ API_KEY: 'sk-old' });
      resetSecretProvider();
      return value;
    })();

    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });

    expect(decryptWithKeyGeneration(encrypted)).toEqual({
      plaintext: 'pre-rotation-secret',
      key: 'previous',
    });
    expect(decrypt(encrypted)).toBe('pre-rotation-secret');
    expect(decryptJSON(encryptedJson)).toEqual({ API_KEY: 'sk-old' });
  });

  it('always encrypts with the current key', () => {
    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });
    const encrypted = encrypt('fresh-secret');

    useKeys({ ENCRYPTION_KEY: NEW_KEY });
    expect(decrypt(encrypted)).toBe('fresh-secret');

    useKeys({ ENCRYPTION_KEY: OLD_KEY });
    expect(() => decrypt(encrypted)).toThrow();
  });

  it('throws the same error as before when neither key works', () => {
    const encrypted = encryptWith(OTHER_KEY, 'unrelated-secret');

    useKeys({ ENCRYPTION_KEY: NEW_KEY });
    const withoutPrevious = errorFrom(() => decrypt(encrypted));

    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });
    const withPrevious = errorFrom(() => decrypt(encrypted));

    expect(withPrevious.constructor).toBe(withoutPrevious.constructor);
    expect(withPrevious.message).toBe(withoutPrevious.message);
    expect(withPrevious.message).toMatch(/unable to authenticate data/i);
  });

  it('does not fall back when no previous key is configured', () => {
    const encrypted = encryptWith(OLD_KEY, 'pre-rotation-secret');

    useKeys({ ENCRYPTION_KEY: NEW_KEY });

    expect(() => decrypt(encrypted)).toThrow(/unable to authenticate data/i);
  });

  it('reports both key fingerprints when decryptSecrets fails', async () => {
    const encrypted = encryptWith(OTHER_KEY, JSON.stringify({ A: 'b' }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });

    await expect(decryptSecrets(encrypted)).rejects.toThrow(
      /ENCRYPTION_KEY\(length=\d+, fingerprint=[a-f0-9]{12}\); ENCRYPTION_KEY_PREVIOUS\(length=\d+, fingerprint=[a-f0-9]{12}\)/,
    );
  });

  it('re-encrypts previous-key ciphertext passed through an encrypted column', () => {
    const previousCiphertext = encryptWith(OLD_KEY, 'column-secret');
    const currentCiphertext = encryptWith(NEW_KEY, 'column-secret');

    useKeys({ ENCRYPTION_KEY: NEW_KEY, ENCRYPTION_KEY_PREVIOUS: OLD_KEY });

    // Current-key ciphertext passes through untouched.
    expect(userApiKeys.apiKey.mapToDriverValue(currentCiphertext)).toBe(
      currentCiphertext,
    );

    // Previous-key ciphertext is rewritten under the current key.
    const rewritten = userApiKeys.apiKey.mapToDriverValue(
      previousCiphertext,
    ) as string;
    expect(rewritten).not.toBe(previousCiphertext);
    expect(decryptWithKeyGeneration(rewritten)).toEqual({
      plaintext: 'column-secret',
      key: 'current',
    });
  });
});
