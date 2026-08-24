import { generateKeyPairSync, randomUUID } from 'node:crypto';

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
  createAutomationToken,
  validateAutomationToken,
} from '../automation-token';

describe('automation tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a deployment principal bound to a run lease and policy version', async () => {
    const automationRunId = randomUUID();
    mockJwtSign.mockReturnValue('signed-token');

    await expect(
      createAutomationToken({
        automationRunId,
        leaseOwner: 'worker-1',
        policyVersion: 3,
        timeoutMs: 60_000,
      }),
    ).resolves.toBe('signed-token');

    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: automationRunId,
        r: { t: 'automation', p: 'deployment', pv: 3, l: 'worker-1' },
      }),
      testKeyPair.privateKey,
      { algorithm: 'ES256' },
    );
  });

  it('validates the dedicated automation principal without a user', async () => {
    const automationRunId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    mockJwtVerify.mockReturnValue({
      iss: 'rcc',
      sub: automationRunId,
      exp: now + 60,
      iat: now,
      nbf: now - 1,
      v: 1,
      r: { t: 'automation', p: 'deployment', pv: 2, l: 'worker-2' },
    });

    await expect(validateAutomationToken('token')).resolves.toEqual({
      automationRunId,
      leaseOwner: 'worker-2',
      policyVersion: 2,
      principal: 'deployment',
      tokenType: 'automation',
      userId: null,
      version: 1,
    });
  });
});
