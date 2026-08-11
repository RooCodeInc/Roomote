const mockEval = vi.fn();
const mockSrem = vi.fn();
const mockClaimDurable = vi.fn();

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  claimDurablePrReviewAction: (...args: unknown[]) => mockClaimDurable(...args),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mockEval, srem: mockSrem }),
}));

import {
  attachPendingPrReviewActionMessage,
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  discardPendingPrReviewAction,
} from '../pr-review-action';

describe('PR review action state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimDurable.mockResolvedValue(null);
  });

  it('uses the durable action when Redis is unavailable', async () => {
    mockClaimDurable.mockResolvedValue({
      outcome: 'claimed',
      action: {
        taskId: 'task-1',
        repository: 'owner/repo',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
        followUpPrompt: 'Fix the latest review findings.',
        messageId: '333.444',
      },
    });
    mockEval.mockRejectedValue(new Error('redis unavailable'));

    await expect(claimPendingPrReviewAction('nonce-1')).resolves.toMatchObject({
      nonce: 'nonce-1',
      followUpPrompt: 'Fix the latest review findings.',
    });
  });

  it('rejects a retired durable nonce even when stale Redis state remains', async () => {
    mockClaimDurable.mockResolvedValue({ outcome: 'already_handled' });
    mockEval.mockResolvedValue(
      JSON.stringify({
        nonce: 'retired-nonce',
        provider: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
      }),
    );

    await expect(
      claimPendingPrReviewAction('retired-nonce'),
    ).resolves.toBeNull();
  });

  it('removes a superseded nonce from Redis and its thread index', async () => {
    mockEval.mockResolvedValue(
      JSON.stringify({
        nonce: 'old-nonce',
        provider: 'slack',
        channelId: 'C123',
        threadId: '111.222',
      }),
    );
    mockSrem.mockResolvedValue(1);

    await discardPendingPrReviewAction('old-nonce');

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      'pr-review-action:old-nonce',
    );
    expect(mockSrem).toHaveBeenCalledWith(
      'pr-review-action:thread:slack:C123:111.222',
      'old-nonce',
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
});
