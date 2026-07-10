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
  getJobAuthPrivateKey: () => Buffer.from('private-key').toString('base64'),
  getJobAuthPublicKey: () => Buffer.from('public-key').toString('base64'),
  isAuthClientTestEnv: () => false,
}));

import { createRunToken, validateRunToken } from '../run-token';

function tokenPayload(tokenType: 'run' | 'cj') {
  const now = Math.floor(Date.now() / 1000);

  return {
    iss: 'rcc',
    sub: '42',
    exp: now + 60,
    iat: now,
    nbf: now - 1,
    v: 1,
    r: {
      u: 'user-1',
      t: tokenType,
    },
  };
}

describe('run tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues minting only the run discriminator', async () => {
    mockJwtSign.mockReturnValue('signed-token');

    await expect(
      createRunToken({ runId: 42, userId: 'user-1', timeoutMs: 60_000 }),
    ).resolves.toBe('signed-token');

    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({
        r: { u: 'user-1', t: 'run' },
      }),
      'private-key',
      { algorithm: 'ES256' },
    );
  });

  it('normalizes a valid pre-migration discriminator to a run context', async () => {
    mockJwtVerify.mockReturnValue(tokenPayload('cj'));

    await expect(validateRunToken('legacy-token')).resolves.toEqual({
      runId: 42,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    });
  });

  it('continues validating current run tokens', async () => {
    mockJwtVerify.mockReturnValue(tokenPayload('run'));

    await expect(validateRunToken('run-token')).resolves.toMatchObject({
      runId: 42,
      tokenType: 'run',
    });
  });
});
