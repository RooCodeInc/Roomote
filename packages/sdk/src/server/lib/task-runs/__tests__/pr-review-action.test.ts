const mockEval = vi.fn();
const mockGet = vi.fn();
const mockSrem = vi.fn();
const mockFindManySlackInstallations = vi.fn();

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
    db: {
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
} from '../pr-review-action';

describe('PR review action state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockSrem.mockResolvedValue(1);
    mockFindManySlackInstallations.mockResolvedValue([{ teamId: 'T1' }]);
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
});
