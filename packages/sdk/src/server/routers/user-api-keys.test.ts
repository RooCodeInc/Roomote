import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

const {
  mockFindTaskRun,
  mockFindUserApiKey,
  mockDecryptText,
  mockEq,
  mockAnd,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockFindUserApiKey: vi.fn(),
  mockDecryptText: vi.fn((value: string) => `decrypted-${value}`),
  mockEq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  mockAnd: vi.fn((...conditions: unknown[]) => ({ conditions })),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
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
  const auth: RunTokenContext = {
    runId: 42,
    userId: 'owner-user',
    principal: 'user',
    tokenType: 'run',
    version: 1,
  };

  return userApiKeysRouter.createCaller({ auth });
}

describe('userApiKeysRouter', () => {
  const provider = 'design-tool';

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTaskRun.mockResolvedValue({
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

  it('uses taskRuns.actingUserId for run-token key lookups', async () => {
    mockFindTaskRun.mockResolvedValueOnce({
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
    // Confused-deputy chain (flagged in PR #80 review): a run token is held by
    // the sandbox. The exploit was: (1) reassign the run's actingUserId to a
    // victim via taskRuns.update, then (2) read the victim's decrypted key
    // here, because getDecryptedKey resolves the effective user from
    // task_runs.actingUserId.
    //
    // Step (1) is now blocked: taskRuns.update strips actingUserId (asserted
    // in task-runs.test.ts). So the persisted actingUserId still reflects the
    // legitimate actor the trusted server-side writers set — never the
    // attacker-chosen victim. This test pins the downstream half of the chain:
    // the effective user comes only from the persisted actingUserId, so the
    // key lookup targets the legitimate actor and never the victim.
    mockFindTaskRun.mockResolvedValueOnce({
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
