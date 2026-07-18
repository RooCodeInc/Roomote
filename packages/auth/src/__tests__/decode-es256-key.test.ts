import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';

import {
  decodeEs256PrivateKeyPem,
  decodeEs256PublicKeyPem,
} from '../decode-es256-key';

function generateEcKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return { privateKey, publicKey };
}

describe('decodeEs256KeyPem', () => {
  const { privateKey, publicKey } = generateEcKeyPair();

  it('accepts base64-encoded PEM (canonical install format)', () => {
    const encodedPrivate = Buffer.from(privateKey).toString('base64');
    const encodedPublic = Buffer.from(publicKey).toString('base64');

    const decodedPrivate = decodeEs256PrivateKeyPem(
      encodedPrivate,
      'JOB_AUTH_PRIVATE_KEY',
    );
    const decodedPublic = decodeEs256PublicKeyPem(
      encodedPublic,
      'JOB_AUTH_PUBLIC_KEY',
    );

    expect(decodedPrivate).toContain('BEGIN PRIVATE KEY');
    expect(decodedPublic).toContain('BEGIN PUBLIC KEY');

    const token = jwt.sign({ t: 1 }, decodedPrivate, { algorithm: 'ES256' });
    expect(() =>
      jwt.verify(token, decodedPublic, { algorithms: ['ES256'] }),
    ).not.toThrow();
  });

  it('accepts raw PEM including escaped newlines', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    const decoded = decodeEs256PrivateKeyPem(escaped, 'JOB_AUTH_PRIVATE_KEY');
    expect(() =>
      jwt.sign({ t: 1 }, decoded, { algorithm: 'ES256' }),
    ).not.toThrow();
  });

  it('accepts base64-encoded PKCS#8 / SPKI DER', () => {
    const { privateKey: privateKeyObject, publicKey: publicKeyObject } =
      generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateDer = privateKeyObject.export({
      type: 'pkcs8',
      format: 'der',
    }) as Buffer;
    const publicDer = publicKeyObject.export({
      type: 'spki',
      format: 'der',
    }) as Buffer;

    const decodedPrivate = decodeEs256PrivateKeyPem(
      privateDer.toString('base64'),
      'JOB_AUTH_PRIVATE_KEY',
    );
    const decodedPublic = decodeEs256PublicKeyPem(
      publicDer.toString('base64'),
      'JOB_AUTH_PUBLIC_KEY',
    );

    const token = jwt.sign({ t: 1 }, decodedPrivate, { algorithm: 'ES256' });
    expect(() =>
      jwt.verify(token, decodedPublic, { algorithms: ['ES256'] }),
    ).not.toThrow();
  });

  it('rejects symmetric secrets with a clear config error', () => {
    expect(() =>
      decodeEs256PrivateKeyPem('not-a-real-key', 'JOB_AUTH_PRIVATE_KEY'),
    ).toThrow(
      /JOB_AUTH_PRIVATE_KEY must be a base64-encoded P-256 private key/,
    );
  });

  it('rejects empty values', () => {
    expect(() =>
      decodeEs256PrivateKeyPem('   ', 'JOB_AUTH_PRIVATE_KEY'),
    ).toThrow(/JOB_AUTH_PRIVATE_KEY is empty/);
  });
});
