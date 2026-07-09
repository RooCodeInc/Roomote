import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

const {
  mockFindCloudJob,
  mockFindUserApiKey,
  mockDecryptText,
  mockEq,
  mockAnd,
} = vi.hoisted(() => ({
  mockFindCloudJob: vi.fn(),
  mockFindUserApiKey: vi.fn(),
  mockDecryptText: vi.fn((value: string) => `decrypted-${value}`),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...conditions: unknown[]) => ({ conditions })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindCloudJob },
      userApiKeys: { findFirst: mockFindUserApiKey },
    },
  },
  taskRuns: {
    id: 'id',
  },
  userApiKeys: {
    userId: 'userId',
    provider: 'provider',
  },
  eq: mockEq,
  and: mockAnd,
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptText: mockDecryptText,
}));

import { userApiKeysRouter } from './user-api-keys';

function createAuthCaller() {
  const auth: AuthTokenContext = {
    userId: 'owner-user',
    tokenType: 'auth',
    version: 1,
  };

  return userApiKeysRouter.createCaller({ auth });
}

function createJobCaller() {
  const auth: JobTokenContext = {
    cloudJobId: 42,
    userId: 'owner-user',
    principal: 'user',
    tokenType: 'cj',
    version: 1,
  };

  return userApiKeysRouter.createCaller({ auth });
}

describe('userApiKeysRouter', () => {
  const provider = 'design-tool';

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCloudJob.mockResolvedValue({
      userId: 'owner-user',
      actingUserId: null,
    });
  });

  it('uses the authenticated user for direct auth-token lookups', async () => {
    mockFindUserApiKey.mockResolvedValueOnce({ id: 'api-key-1' });

    const result = await createAuthCaller().hasKey({ provider });

    expect(result).toBe(true);
    expect(mockFindUserApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conditions: expect.arrayContaining([
            { column: 'userId', value: 'owner-user' },
            { column: 'provider', value: provider },
          ]),
        }),
      }),
    );
  });

  it('uses taskRuns.actingUserId for job-token key lookups', async () => {
    mockFindCloudJob.mockResolvedValueOnce({
      actingUserId: 'actor-user',
    });
    mockFindUserApiKey.mockResolvedValueOnce({ apiKey: 'encrypted-api-key' });

    const result = await createJobCaller().getDecryptedKey({
      provider,
    });

    expect(result).toBe('decrypted-encrypted-api-key');
    expect(mockFindUserApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conditions: expect.arrayContaining([
            { column: 'userId', value: 'actor-user' },
            { column: 'provider', value: provider },
          ]),
        }),
      }),
    );
    expect(mockDecryptText).toHaveBeenCalledWith('encrypted-api-key');
  });
});
