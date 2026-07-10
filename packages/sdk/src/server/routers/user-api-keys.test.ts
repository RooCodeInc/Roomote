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

  it('cannot read a victim user key after a blocked acting-user reassignment', async () => {
    // Confused-deputy chain (flagged in PR #80 review): a job token is held by
    // the sandbox. The exploit was: (1) reassign the run's actingUserId to a
    // victim via cloudJobs.update, then (2) read the victim's decrypted key
    // here, because getDecryptedKey resolves the effective user from
    // task_runs.actingUserId.
    //
    // Step (1) is now blocked: cloudJobs.update strips actingUserId (asserted
    // in cloud-jobs.test.ts). So the persisted actingUserId still reflects the
    // legitimate actor the trusted server-side writers set — never the
    // attacker-chosen victim. This test pins the downstream half of the chain:
    // the effective user comes only from the persisted actingUserId, so the
    // key lookup targets the legitimate actor and never the victim.
    mockFindCloudJob.mockResolvedValueOnce({
      // The value that survives in the DB is the legitimate actor, because the
      // sandbox's reassignment to 'victim-user' was stripped upstream.
      actingUserId: 'owner-user',
    });
    mockFindUserApiKey.mockResolvedValueOnce({ apiKey: 'owner-encrypted-key' });

    const result = await createJobCaller().getDecryptedKey({ provider });

    expect(result).toBe('decrypted-owner-encrypted-key');
    // The lookup is scoped to the legitimate actor, never the victim.
    const lookupArg = mockFindUserApiKey.mock.calls[0]![0] as {
      where: { conditions: Array<{ column: string; value: unknown }> };
    };
    expect(lookupArg.where.conditions).toContainEqual({
      column: 'userId',
      value: 'owner-user',
    });
    expect(lookupArg.where.conditions).not.toContainEqual({
      column: 'userId',
      value: 'victim-user',
    });
  });
});
