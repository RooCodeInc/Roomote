import { generateKeyPairSync } from 'node:crypto';

const testKeyPair = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const { mockJwtSign, mockJwtVerify } = vi.hoisted(() => ({
  mockJwtSign: vi.fn(),
  mockJwtVerify: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (...args: unknown[]) => mockJwtSign(...args),
    verify: (...args: unknown[]) => mockJwtVerify(...args),
  },
}));

vi.mock('../client-runtime', () => ({
  getJobAuthPrivateKey: () =>
    Buffer.from(testKeyPair.privateKey).toString('base64'),
  getJobAuthPublicKey: () =>
    Buffer.from(testKeyPair.publicKey).toString('base64'),
  isAuthClientTestEnv: () => false,
}));

import {
  createMcpAccessToken,
  ROOMOTE_MCP_SCOPE,
  validateMcpAccessToken,
} from '../mcp-access-token';

const resource = 'https://api.example.com/api/mcp-routing/roomote';

describe('MCP access tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a resource- and scope-bound token', async () => {
    mockJwtSign.mockReturnValue('signed-token');

    await expect(
      createMcpAccessToken({
        userId: 'user-1',
        resource,
        scopes: [ROOMOTE_MCP_SCOPE],
        timeoutMs: 60_000,
      }),
    ).resolves.toBe('signed-token');

    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        aud: resource,
        r: { u: 'user-1', t: 'mcp', s: [ROOMOTE_MCP_SCOPE] },
      }),
      testKeyPair.privateKey,
      { algorithm: 'ES256' },
    );
  });

  it('returns the resource boundary when validating', async () => {
    const now = Math.floor(Date.now() / 1000);
    mockJwtVerify.mockReturnValue({
      iss: 'rcc',
      sub: 'user-1',
      aud: resource,
      exp: now + 60,
      iat: now,
      nbf: now - 1,
      v: 1,
      r: { u: 'user-1', t: 'mcp', s: [ROOMOTE_MCP_SCOPE] },
    });

    await expect(validateMcpAccessToken('token')).resolves.toEqual({
      userId: 'user-1',
      tokenType: 'mcp',
      version: 1,
      resource,
      scopes: [ROOMOTE_MCP_SCOPE],
    });
  });
});
