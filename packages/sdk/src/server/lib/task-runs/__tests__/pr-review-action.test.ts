const {
  mockEval,
  mockGet,
  mockSrem,
  mockFindManySlackInstallations,
  mockUpdateReturning,
  mockUpdate,
} = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  return {
    mockEval: vi.fn(),
    mockGet: vi.fn(),
    mockSrem: vi.fn(),
    mockFindManySlackInstallations: vi.fn(),
    mockUpdateReturning,
    mockUpdate: vi.fn(() => ({ set: mockUpdateSet })),
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
    db: {
      update: mockUpdate,
      query: {
        slackInstallations: {
          findMany: (...args: unknown[]) =>
            mockFindManySlackInstallations(...args),
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
  setPendingPrReviewAction,
} from '../pr-review-action';

describe('PR review action state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSrem.mockResolvedValue(1);
    mockFindManySlackInstallations.mockResolvedValue([{ teamId: 'T1' }]);
    mockUpdateReturning.mockResolvedValue([{ id: 'link-1' }]);
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
    mockEval.mockResolvedValue([]);

    await expect(
      attachPendingPrReviewActionMessage('nonce-1', 'message-1'),
    ).resolves.toEqual([]);

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
      attachPendingPrReviewActionMessage('nonce-new', 'message-new'),
    ).resolves.toEqual([
      expect.objectContaining({
        nonce: 'nonce-old',
        messageId: 'message-old',
      }),
    ]);

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
      JSON.stringify({ ...lateOffer, messageId: 'message-old' }),
    ]);

    await expect(
      attachPendingPrReviewActionMessage('nonce-old', 'message-old'),
    ).resolves.toEqual([
      expect.objectContaining({
        nonce: 'nonce-old',
        messageId: 'message-old',
        retired: true,
      }),
    ]);
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

  it('fails when auto-handling cannot be persisted to the linked PR', async () => {
    mockUpdateReturning.mockResolvedValue([]);

    await expect(
      enableAutoHandlePrReviewFeedback({
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        userId: 'user-1',
      }),
    ).rejects.toThrow('linked pull request was not found');
  });
});
