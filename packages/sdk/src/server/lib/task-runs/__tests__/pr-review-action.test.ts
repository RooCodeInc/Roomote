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
  mockSlackThreadFence,
  mockGetCommunicationProviderAdapter,
  mockSlackInstallation,
  mockSlackBlocks,
  mockSlackUpdate,
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
    mockSlackThreadFence: vi.fn(),
    mockGetCommunicationProviderAdapter: vi.fn(),
    mockSlackInstallation: vi.fn(),
    mockSlackBlocks: vi.fn(),
    mockSlackUpdate: vi.fn(),
  };
});

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  SlackNotifier: class {
    getMessageBlocks = mockSlackBlocks;
    updateMessage = mockSlackUpdate;
  },
}));

vi.mock('../../communication-providers', () => ({
  getCommunicationProviderAdapter: (...args: unknown[]) =>
    mockGetCommunicationProviderAdapter(...args),
}));

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
    attachCanonicalPrReviewActionMessageWithRetirement: (...args: unknown[]) =>
      mockAttachCanonical(...args),
    withCanonicalPrReviewSlackThreadActionFence: (...args: unknown[]) =>
      mockSlackThreadFence(...args),
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
          findFirst: mockSlackInstallation,
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
  retirePrReviewActionMessagesBestEffort,
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
    mockAttachCanonical.mockResolvedValue({
      attached: false,
      superseded: [],
    });
    mockSlackThreadFence.mockImplementation(
      async (
        _input,
        arbitrate: (messageId: string | null) => Promise<unknown>,
      ) => {
        const arbitration = (await arbitrate(null)) as { result: unknown };
        return { result: arbitration.result, superseded: [] };
      },
    );
    mockGetCommunicationProviderAdapter.mockResolvedValue(null);
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
    mockEval.mockResolvedValue([1, 'message-1']);

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
      '',
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

  it('returns and de-indexes a prior Slack offer for another PR in the same thread', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify({
        nonce: 'nonce-new',
        provider: 'slack',
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '111.222',
        repository: 'other/repository',
        prNumber: 99,
      }),
    );
    mockEval.mockResolvedValue([
      1,
      '200.000002',
      JSON.stringify({
        nonce: 'nonce-old',
        provider: 'slack',
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '111.222',
        repository: 'owner/repo',
        prNumber: 42,
        messageId: '200.000001',
      }),
    ]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        'nonce-new',
        '200.000002',
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [
        expect.objectContaining({
          nonce: 'nonce-old',
          messageId: '200.000001',
        }),
      ],
    });

    expect(mockEval.mock.calls[0]?.[3]).toBe(
      'pr-review-action:thread:slack:T1:C1:111.222',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      "if pending.provider == 'slack' then",
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      "return prior.provider == 'slack' and sameSlackTeam",
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'prior.messageId and prior.messageId > winner',
    );
    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'prior.repository == pending.repository',
    );
    expect(mockSlackThreadFence).toHaveBeenCalledWith(
      {
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '111.222',
      },
      expect.any(Function),
    );
  });

  it('retires older canonical controls when a later-posted legacy offer wins', async () => {
    const pending = {
      nonce: 'legacy-newer',
      provider: 'slack' as const,
      slackTeamId: 'T1',
      taskId: 'legacy-task',
      repository: 'legacy/repository',
      prNumber: 99,
      prUrl: 'https://github.com/legacy/repository/pull/99',
      channelId: 'C1',
      threadId: '111.222',
      followUpPrompt: 'Address the newer feedback.',
    };
    mockGet.mockResolvedValue(JSON.stringify(pending));
    mockEval.mockResolvedValue([1, '200.000002']);
    mockSlackThreadFence.mockImplementation(async (_input, arbitrate) => {
      const arbitration = await arbitrate('200.000001');
      return {
        result: arbitration.result,
        superseded: [
          {
            deliveryId: '00000000-0000-4000-8000-000000000001',
            provider: 'slack',
            slackTeamId: 'T1',
            channelId: 'C1',
            threadId: '111.222',
            messageId: '200.000001',
          },
        ],
      };
    });

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        pending.nonce,
        '200.000002',
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [expect.objectContaining({ messageId: '200.000001' })],
    });

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'pr-review-action:legacy-newer',
      'pr-review-action:thread:slack:T1:C1:111.222',
      '200.000002',
      'pr-review-action:',
      '200.000001',
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
      'message-old',
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

  it('returns canonical and legacy Slack offers from other PRs in the same thread', async () => {
    const context = {
      nonce: '00000000-0000-4000-8000-000000000001',
      canonicalDeliveryId: '00000000-0000-4000-8000-000000000001',
      provider: 'slack' as const,
      slackTeamId: 'T1',
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
      repository: 'legacy/repository',
      prNumber: 7,
      messageId: 'legacy-message',
    };
    mockAttachCanonical.mockImplementation(
      async (_nonce, _messageId, _leaseToken, options) => {
        await options.arbitrateSlackThread('200.000002');
        return {
          attached: true,
          superseded: [
            {
              deliveryId: '00000000-0000-4000-8000-000000000002',
              provider: 'slack',
              slackTeamId: 'T1',
              channelId: 'channel-1',
              threadId: 'thread-1',
              messageId: '200.000001',
            },
          ],
        };
      },
    );
    mockEval.mockResolvedValue([
      '200.000002',
      JSON.stringify({ ...legacy, messageId: '100.000001' }),
    ]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        context.nonce,
        '200.000002',
        { leaseToken: 'lease-token', context },
      ),
    ).resolves.toEqual({
      attached: true,
      superseded: [
        expect.objectContaining({ messageId: '200.000001' }),
        expect.objectContaining({ nonce: 'legacy-nonce' }),
      ],
    });

    expect(mockEval.mock.calls[0]?.[0]).toContain(
      'pending.messageId and pending.messageId > winner',
    );
    expect(mockEval.mock.calls[0]?.[2]).toBe(
      'pr-review-action:thread:slack:T1:channel-1:thread-1',
    );
  });

  it('visually retires Redis losers when canonical attachment rolls back after arbitration', async () => {
    const context = {
      nonce: '00000000-0000-4000-8000-000000000003',
      canonicalDeliveryId: '00000000-0000-4000-8000-000000000003',
      provider: 'slack' as const,
      slackTeamId: 'T1',
      taskId: 'task-1',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      channelId: 'C1',
      threadId: '111.222',
      followUpPrompt: 'Address the feedback.',
    };
    const legacy = {
      ...context,
      nonce: 'legacy-loser',
      canonicalDeliveryId: undefined,
      messageId: '100.000001',
    };
    mockEval.mockResolvedValue(['100.000002', JSON.stringify(legacy)]);
    mockAttachCanonical.mockImplementation(
      async (_nonce, _messageId, _leaseToken, options) => {
        await options.arbitrateSlackThread('100.000002');
        throw new Error('database commit failed');
      },
    );
    mockSlackInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mockSlackBlocks.mockResolvedValue([
      { type: 'markdown', text: 'Review text remains.' },
      { type: 'actions', block_id: 'pr_review_action', elements: [] },
    ]);

    await expect(
      attachPendingPrReviewActionMessageWithRetirement(
        context.nonce,
        '100.000002',
        { leaseToken: 'lease-token', context },
      ),
    ).rejects.toThrow('database commit failed');
    expect(mockSlackUpdate).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '100.000001',
      message: {
        blocks: [{ type: 'markdown', text: 'Review text remains.' }],
      },
    });
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

  it('retires a superseded chat message even when its task link is gone', async () => {
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
    mockGetCommunicationProviderAdapter.mockResolvedValue({
      provider: 'telegram',
      editMessageReplyMarkup,
    });
    mockRetireCanonicalForPullRequest.mockResolvedValue([
      {
        deliveryId: '33333333-3333-4333-8333-333333333333',
        destinationKind: 'task',
        status: 'dismissed',
        provider: 'telegram',
        slackTeamId: null,
        taskId: null,
        sourceControlProvider: 'github',
        host: null,
        repositoryId: null,
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        channelId: 'chat-1',
        threadId: null,
        followUpPrompt: 'Resolve the review feedback.',
        messageId: '456',
        destinationKey: 'task-1',
      },
    ]);

    await retirePendingPrReviewActionsForPullRequest({
      sourceControlProvider: 'github',
      repository: 'owner/repo',
      prNumber: 42,
      currentHeadSha: 'new-head',
    });

    expect(editMessageReplyMarkup).toHaveBeenCalledWith({
      channelId: 'chat-1',
      messageId: '456',
    });
  });

  it('retires superseded Slack controls without adding a notice', async () => {
    const summary = { type: 'markdown', text: 'Review findings.' };
    mockSlackInstallation.mockResolvedValue({ botAccessToken: 'test-token' });
    mockSlackBlocks.mockResolvedValue([
      summary,
      { type: 'actions', block_id: 'pr_review_action', elements: [] },
    ]);

    await retirePrReviewActionMessagesBestEffort([
      {
        provider: 'slack',
        slackTeamId: 'T1',
        channelId: 'C1',
        threadId: '1.0',
        messageId: '2.0',
      },
    ]);

    expect(mockSlackUpdate).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '2.0',
      message: { blocks: [summary] },
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
