import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { configureAuthClientEnv } from '../client-runtime';
import {
  createSandboxOidcToken,
  getSandboxOidcDiscoveryDocument,
  getSandboxOidcIssuer,
  getSandboxOidcJwks,
  getSandboxOidcKeyId,
} from '../sandbox-oidc';

vi.mock('@roomote/env', () => ({
  Env: {
    NODE_ENV: 'test',
    ROOMOTE_APP_URL: 'https://app.roomote.test',
    TRPC_URL: 'https://app.roomote.test/_roomote-api/',
  },
}));

function encodePem(pem: string): string {
  return Buffer.from(pem).toString('base64');
}

function generateEcKeyPair(): {
  privateKey: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });

  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('sandbox OIDC helpers', () => {
  const currentKeyPair = generateEcKeyPair();
  const secondaryKeyPair = generateEcKeyPair();

  beforeEach(() => {
    configureAuthClientEnv({
      sandboxOidcPrivateKey: encodePem(currentKeyPair.privateKey),
      sandboxOidcPublicKey: encodePem(currentKeyPair.publicKey),
      sandboxOidcPublicKeySecondary: undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureAuthClientEnv(null);
  });

  it('uses the pathful API-facing URL as the stable OIDC issuer', () => {
    expect(getSandboxOidcIssuer()).toBe(
      'https://app.roomote.test/_roomote-api',
    );
  });

  it('publishes both current and secondary verification keys in JWKS', () => {
    configureAuthClientEnv({
      sandboxOidcPrivateKey: encodePem(currentKeyPair.privateKey),
      sandboxOidcPublicKey: encodePem(currentKeyPair.publicKey),
      sandboxOidcPublicKeySecondary: encodePem(secondaryKeyPair.publicKey),
    });

    const jwks = getSandboxOidcJwks();

    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.map((key) => key.kid)).toEqual([
      getSandboxOidcKeyId(encodePem(currentKeyPair.publicKey)),
      getSandboxOidcKeyId(encodePem(secondaryKeyPair.publicKey)),
    ]);
  });

  it('deduplicates duplicate verification keys in JWKS', () => {
    configureAuthClientEnv({
      sandboxOidcPrivateKey: encodePem(currentKeyPair.privateKey),
      sandboxOidcPublicKey: encodePem(currentKeyPair.publicKey),
      sandboxOidcPublicKeySecondary: encodePem(currentKeyPair.publicKey),
    });

    const jwks = getSandboxOidcJwks();

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(
      getSandboxOidcKeyId(encodePem(currentKeyPair.publicKey)),
    );
  });

  it('continues signing with the current private key only', () => {
    const signSpy = vi
      .spyOn(jwt, 'sign')
      .mockImplementation(() => 'mock-token');

    configureAuthClientEnv({
      sandboxOidcPrivateKey: encodePem(currentKeyPair.privateKey),
      sandboxOidcPublicKey: encodePem(currentKeyPair.publicKey),
      sandboxOidcPublicKeySecondary: encodePem(secondaryKeyPair.publicKey),
    });

    const token = createSandboxOidcToken({
      environmentId: 'env_456',
      audience: 'sts.amazonaws.com',
      now: new Date('2026-01-01T00:00:00Z'),
    });

    expect(token).toBe('mock-token');
    expect(signSpy.mock.calls[0]?.[1]).toBe(currentKeyPair.privateKey);
    expect(signSpy.mock.calls[0]?.[2]).toMatchObject({
      algorithm: 'ES256',
      keyid: getSandboxOidcKeyId(encodePem(currentKeyPair.publicKey)),
    });
  });

  it('publishes environment-scoped subject and claims in discovery + tokens', () => {
    const token = createSandboxOidcToken({
      environmentId: 'env_456',
      audience: 'sts.amazonaws.com',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const decoded = jwt.decode(token);

    expect(decoded).toMatchObject({
      sub: 'env:env_456',
      aud: 'sts.amazonaws.com',
      environment_id: 'env_456',
    });
    expect(getSandboxOidcDiscoveryDocument()).toMatchObject({
      issuer: 'https://app.roomote.test/_roomote-api',
      jwks_uri: 'https://app.roomote.test/_roomote-api/api/oidc/jwks',
      claims_supported: expect.arrayContaining(['sub', 'environment_id']),
    });
  });
});
