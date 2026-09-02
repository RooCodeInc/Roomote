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
  mockRetireCanonicalForPullRequest,
  mockAttachCanonical,
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
    mockRetireCanonicalForPullRequest: vi.fn(),
    mockAttachCanonical: vi.fn(),
  };
});

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    eval: mockEval,
    get: mockGet,
    srem: mockSrem,
  }),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    attachCanonicalPrReviewActionMessage: (...args: unknown[]) =>
      mockAttachCanonical(...args),
    claimCanonicalPrReviewAction: vi.fn().mockResolvedValue(null),
    retireCanonicalPrReviewActionsForDestination: (...args: unknown[]) =>
      mockRetireCanonical(...args),
    retireCanonicalPrReviewActionsForPullRequest: (...args: unknown[]) =>
      mockRetireCanonicalForPullRequest(...args),
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
  attachPendingPrReviewActionMessageWithRetirement,
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  enableAutoHandlePrReviewFeedback,
  retirePendingPrReviewActionsForPullRequest,
  setPendingPrReviewAction,
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
    mockRetireCanonicalForPullRequest.mockResolvedValue([]);
    mockAttachCanonical.mockResolvedValue(false);
  });

  it('creates and orders each nonce atomically without overwriting retries', async () => {
    mockEval.mockResolvedValue(1);

    await setPendingPrReviewAction({
      nonce: 'nonce-1',
      provider: 'discord',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: 'Address the feedback.',
    });

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining(
        "if redis.call('exists', KEYS[1]) == 1 then return 0 end",
      ),
      3,
      'pr-review-action:nonce-1',
      'pr-review-action:thread:discord:channel-1:thread-1',
      'pr-review-action:order',
      expect.stringContaining('"nonce":"nonce-1"'),
      String(7 * 24 * 60 * 60),
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      "pending.createdOrder = redis.call('incr', KEYS[3])",
    );
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
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'if pending.retired then return nil end',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      "redis.call('set', KEYS[1], cjson.encode(pending), 'KEEPTTL')",
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
    mockGet.mockResolvedValue(
      JSON.stringify({
        nonce: 'nonce-1',
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    );
    mockEval.mockResolvedValue([1]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement('nonce-1', 'message-1'),
    ).resolves.toEqual({ attached: true, superseded: [] });

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1])"),
      2,
      'pr-review-action:nonce-1',
      'pr-review-action:thread:discord:channel-1:thread-1',
      'message-1',
      'pr-review-action:',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain("'KEEPTTL'");
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'prior.repository == pending.repository',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'priorCreatedOrder > pendingCreatedOrder',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain("redis.call('del', KEYS[1])");
    expect(mockEval.mock.calls[0]?.[0]).toContain('pending.retired');
    expect(mockEval.mock.calls[0]?.[0]).toContain('prior.retired = true');
  });

  it('returns and de-indexes the prior offer for the same PR context', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({
        nonce: 'nonce-new',
        provider: 'slack',
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '111.222',
        repository: 'owner/repo',
        prNumber: 42,
      }),
    );
    mockEval.mockResolvedValue([
      1,
      JSON.stringify({
        nonce: 'nonce-old',
        provider: 'slack',
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '111.222',
        repository: 'owner/repo',
        prNumber: 42,
        messageId: 'message-old',
      }),
    ]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        'nonce-new',
        'message-new',
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [
        expect.objectContaining({
          nonce: 'nonce-old',
          messageId: 'message-old',
        }),
      ],
    });

    expect(mockEval.mock.calls[0]?.[3]).toBe(
      'pr-review-action:thread:slack:T1:C1:111.222',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'prior.prNumber == pending.prNumber',
    );
  });

  it('returns a late-posting offer so its own stale controls are retired', async () => {
    const lateOffer = {
      nonce: 'nonce-old',
      provider: 'discord',
      createdOrder: 1,
      retired: true,
      channelId: 'channel-1',
      threadId: 'thread-1',
      repository: 'owner/repo',
      prNumber: 42,
    };
    mockGet.mockResolvedValue(JSON.stringify(lateOffer));
    mockEval.mockResolvedValue([
      1,
      JSON.stringify({ ...lateOffer, messageId: 'message-old' }),
    ]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        'nonce-old',
        'message-old',
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [
        expect.objectContaining({
          nonce: 'nonce-old',
          messageId: 'message-old',
          retired: true,
        }),
      ],
    });
  });

  it('retires legacy offers after a canonical attachment succeeds', async () => {
    const context = {
      nonce: '00000000-0000-4000-8000-000000000001',
      canonicalDeliveryId: '00000000-0000-4000-8000-000000000001',
      provider: 'discord' as const,
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      channelId: 'channel-1',
      threadId: 'thread-1',
      followUpPrompt: 'Address the feedback.',
    };
    const legacy = {
      ...context,
      nonce: 'legacy-nonce',
      canonicalDeliveryId: undefined,
      messageId: 'legacy-message',
    };
    mockAttachCanonical.mockResolvedValue(true);
    mockEval.mockResolvedValue([JSON.stringify(legacy)]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        context.nonce,
        'canonical-message',
        { leaseToken: 'lease-token', context },
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [expect.objectContaining({ nonce: 'legacy-nonce' })],
    });

    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'pending.repository == context.repository',
    );
    expect(mockEval.mock.calls[0]?.[2]).toBe(
      'pr-review-action:thread:discord:channel-1:thread-1',
    );
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
    expect(mockEval.mock.calls[0]?.[0]).toContain('pending.retired = true');
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

  it('retires canonical offers for older heads when a PR receives a commit', async () => {
    await retirePendingPrReviewActionsForPullRequest({
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      currentHeadSha: 'new-head',
    });

    expect(mockRetireCanonicalForPullRequest).toHaveBeenCalledWith({
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      currentHeadSha: 'new-head',
    });
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
