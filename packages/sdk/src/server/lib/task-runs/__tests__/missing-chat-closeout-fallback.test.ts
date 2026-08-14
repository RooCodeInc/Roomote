const { redisDel, redisSet } = vi.hoisted(() => ({
  redisDel: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ del: redisDel, set: redisSet }),
}));

import {
  claimMissingChatCloseoutFallbackDelivery,
  releaseMissingChatCloseoutFallbackDelivery,
} from '../missing-chat-closeout-fallback';

describe('missing chat closeout fallback delivery claims', () => {
  beforeEach(() => {
    redisDel.mockReset();
    redisSet.mockReset();
  });

  it('claims a run once with a bounded TTL', async () => {
    redisSet.mockResolvedValue('OK');

    await expect(
      claimMissingChatCloseoutFallbackDelivery({
        runId: 42,
        completionId: 'completion-1',
      }),
    ).resolves.toEqual({ claimed: true });

    expect(redisSet).toHaveBeenCalledWith(
      'missing-chat-closeout-fallback:42:completion-1',
      '1',
      'EX',
      604_800,
      'NX',
    );
  });

  it('reports duplicate claims and can release a failed delivery', async () => {
    redisSet.mockResolvedValue(null);
    redisDel.mockResolvedValue(1);

    await expect(
      claimMissingChatCloseoutFallbackDelivery({
        runId: 42,
        completionId: 'completion-1',
      }),
    ).resolves.toEqual({ claimed: false });

    await releaseMissingChatCloseoutFallbackDelivery({
      runId: 42,
      completionId: 'completion-1',
    });

    expect(redisDel).toHaveBeenCalledWith(
      'missing-chat-closeout-fallback:42:completion-1',
    );
  });
});
