const {
  mockEval,
  mockGet,
  mockSrem,
  mockFindManySlackInstallations,
  mockFindFirstTaskPullRequest,
  mockUpdateReturning,
  mockUpdate,
  mockUpsertPreference,
  mockFindPreference,
  mockRetireCanonical,
} = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));

  return {
    mockEval: vi.fn(),
    mockGet: vi.fn(),
    mockSrem: vi.fn(),
    mockFindManySlackInstallations: vi.fn(),
    mockFindFirstTaskPullRequest: vi.fn(),
    mockUpdateReturning,
    mockUpdate: vi.fn(() => ({ set: mockUpdateSet })),
    mockUpsertPreference: vi.fn(),
    mockFindPreference: vi.fn(),
    mockRetireCanonical: vi.fn(),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mockEval, get: mockGet, srem: mockSrem }),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    attachCanonicalPrReviewActionMessage: vi.fn().mockResolvedValue(false),
    claimCanonicalPrReviewAction: vi.fn().mockResolvedValue(null),
    retireCanonicalPrReviewActionsForDestination: (...args: unknown[]) =>
      mockRetireCanonical(...args),
    upsertPrReviewAutoPreference: (...args: unknown[]) =>
      mockUpsertPreference(...args),
    findPrReviewAutoPreference: (...args: unknown[]) =>
      mockFindPreference(...args),
    db: {
      update: mockUpdate,
      query: {
        slackInstallations: {
          findMany: (...args: unknown[]) =>
            mockFindManySlackInstallations(...args),
        },
        taskPullRequests: {
          findFirst: (...args: unknown[]) =>
            mockFindFirstTaskPullRequest(...args),
        },
      },
    },
  };
});

import {
  attachPendingPrReviewActionMessage,
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  enableAutoHandlePrReviewFeedback,
  findAutoHandlePrReviewFeedbackPreference,
} from '../pr-review-action';

describe('PR review action state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSrem.mockResolvedValue(1);
    mockFindManySlackInstallations.mockResolvedValue([{ teamId: 'T1' }]);
    mockFindFirstTaskPullRequest.mockResolvedValue(null);
    mockUpdateReturning.mockResolvedValue([{ id: 'link-1' }]);
    mockUpsertPreference.mockResolvedValue(undefined);
    mockFindPreference.mockResolvedValue(null);
    mockRetireCanonical.mockResolvedValue([]);
  });

  it('does not consume an offer from another Slack workspace', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({
        nonce: 'nonce-1',
        provider: 'slack',
        slackTeamId: 'T1',
      }),
    );
    mockEval.mockResolvedValue(null);

    await expect(
      claimPendingPrReviewAction('nonce-1', {
        expectedSlackTeamId: 'T2',
      }),
    ).resolves.toBeNull();

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining('pending.slackTeamId ~= ARGV[1]'),
      1,
      'pr-review-action:nonce-1',
      'T2',
      '0',
    );
  });

  it('claims a legacy Slack offer only for the sole active workspace', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({ nonce: 'nonce-1', provider: 'slack' }),
    );
    mockEval.mockResolvedValue(
      JSON.stringify({ nonce: 'nonce-1', provider: 'slack' }),
    );

    await expect(
      claimPendingPrReviewAction('nonce-1', {
        expectedSlackTeamId: 'T1',
      }),
    ).resolves.toMatchObject({ nonce: 'nonce-1' });

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'pr-review-action:nonce-1',
      'T1',
      '1',
    );
  });

  it('does not consume a legacy Slack offer when workspaces are ambiguous', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({ nonce: 'nonce-1', provider: 'slack' }),
    );
    mockFindManySlackInstallations.mockResolvedValue([
      { teamId: 'T1' },
      { teamId: 'T2' },
    ]);
    mockEval.mockResolvedValue(null);

    await expect(
      claimPendingPrReviewAction('nonce-1', {
        expectedSlackTeamId: 'T1',
      }),
    ).resolves.toBeNull();

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'pr-review-action:nonce-1',
      'T1',
      '0',
    );
  });

  it('attaches notification ids with an atomic compare-and-update script', async () => {
    mockEval.mockResolvedValue(1);

    await attachPendingPrReviewActionMessage('nonce-1', 'message-1');

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1])"),
      1,
      'pr-review-action:nonce-1',
      'message-1',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain("'KEEPTTL'");
  });

  it('claims every indexed offer through one atomic script', async () => {
    mockEval.mockResolvedValue([
      JSON.stringify({ nonce: 'nonce-1', messageId: 'message-1' }),
    ]);

    await expect(
      claimPendingPrReviewActionsForThread({
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    ).resolves.toEqual([{ nonce: 'nonce-1', messageId: 'message-1' }]);

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('smembers', KEYS[1])"),
      1,
      'pr-review-action:thread:discord:channel-1:thread-1',
      'pr-review-action:',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain("redis.call('del', KEYS[1])");
  });

  it('isolates Slack thread indexes by workspace', async () => {
    mockEval.mockResolvedValue([]);

    await claimPendingPrReviewActionsForThread({
      provider: 'slack',
      slackTeamId: 'T2',
      channelId: 'C-shared',
      threadId: '111.222',
    });

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'pr-review-action:thread:slack:T2:C-shared:111.222',
      'pr-review-action:',
    );
  });

  it('fails when auto-handling cannot be persisted to the linked PR', async () => {
    mockUpsertPreference.mockRejectedValue(
      new Error('linked pull request was not found'),
    );

    await expect(
      enableAutoHandlePrReviewFeedback({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        userId: 'user-1',
      }),
    ).rejects.toThrow('linked pull request was not found');
  });

  it('resolves auto-handling across task links for the same provider PR', async () => {
    mockFindFirstTaskPullRequest.mockResolvedValue({
      taskId: 'parent-task',
      autoHandleFeedbackByUserId: 'user-1',
    });
    mockFindPreference.mockResolvedValue({
      taskId: 'parent-task',
      userId: 'user-1',
      destinationKey: null,
    });

    await enableAutoHandlePrReviewFeedback({
      taskId: 'parent-task',
      repository: 'owner/repo',
      prNumber: 42,
      userId: 'user-1',
    });

    await expect(
      findAutoHandlePrReviewFeedbackPreference({
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    ).resolves.toEqual({
      taskId: 'parent-task',
      userId: 'user-1',
      destinationKey: null,
    });
    expect(mockUpsertPreference.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindPreference.mock.invocationCallOrder[0]!,
    );
  });
});
