const mockEval = vi.fn();

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mockEval }),
}));

import {
  attachPendingPrReviewActionMessage,
  claimPendingPrReviewActionsForThread,
} from '../pr-review-action';

describe('PR review action state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
