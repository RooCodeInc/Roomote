import { createPrivateKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { normalizePemEnvValue } from './environment-variables';

const { privateKey: realPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('normalizePemEnvValue', () => {
  it('repairs a PEM whose newlines were flattened to spaces by a single-line paste', () => {
    const flattened = realPem.replace(/\r?\n/g, ' ').trim();

    const normalized = normalizePemEnvValue(flattened);

    expect(normalized).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it('repairs a PEM with literal backslash-n sequences', () => {
    const escaped = realPem.replace(/\r?\n/g, '\\n');

    const normalized = normalizePemEnvValue(escaped);

    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it('strips surrounding quotes before repairing', () => {
    const quoted = `"${realPem.replace(/\r?\n/g, ' ').trim()}"`;

    const normalized = normalizePemEnvValue(quoted);

    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it('keeps an already-canonical PEM parseable', () => {
    const normalized = normalizePemEnvValue(realPem);

    expect(() => createPrivateKey(normalized)).not.toThrow();
  });

  it('leaves non-PEM values untouched', () => {
    expect(normalizePemEnvValue('sk-or-v1-abc123')).toBe('sk-or-v1-abc123');
    expect(normalizePemEnvValue('plain value with spaces')).toBe(
      'plain value with spaces',
    );
    expect(normalizePemEnvValue('')).toBe('');
  });

  it('leaves multi-block PEM bundles untouched', () => {
    const bundle = `${realPem}${realPem}`;

    expect(normalizePemEnvValue(bundle)).toBe(bundle);
  });

  it('leaves blocks with mismatched labels untouched', () => {
    const mismatched =
      '-----BEGIN PRIVATE KEY-----\nabcd\n-----END CERTIFICATE-----';

    expect(normalizePemEnvValue(mismatched)).toBe(mismatched);
  });
});
