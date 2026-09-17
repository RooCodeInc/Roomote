const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mocks.eval }),
}));

vi.mock('../constants.js', () => ({
  EVENT_DEDUP_TTL_SECONDS: 3600,
  SLACK_EVENT_DEDUP_PREFIX: 'slack:event:',
}));

import {
  claimSlackEvent,
  completeSlackEventClaim,
  renewSlackEventClaim,
} from '../event-gate.js';

describe('Slack event gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a short processing lease and a one-hour completed TTL', async () => {
    mocks.eval.mockResolvedValueOnce('claimed').mockResolvedValueOnce(1);

    const result = await claimSlackEvent('Ev123');
    expect(result).toEqual({
      status: 'claimed',
      claim: {
        key: 'slack:event:Ev123',
        token: expect.stringMatching(/^processing:/u),
      },
    });
    if (result.status !== 'claimed') {
      throw new Error('Expected the Slack event to be claimed');
    }

    await expect(completeSlackEventClaim(result.claim)).resolves.toBe(true);
    expect(mocks.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("return 'claimed'"),
      1,
      'slack:event:Ev123',
      result.claim.token,
      '30',
    );
    expect(mocks.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("'done'"),
      1,
      'slack:event:Ev123',
      result.claim.token,
      '3600',
    );
  });

  it('renews only the owned processing lease for 30 seconds', async () => {
    mocks.eval.mockResolvedValue(1);

    await expect(
      renewSlackEventClaim({
        key: 'slack:event:Ev123',
        token: 'processing:owner',
      }),
    ).resolves.toBe(true);

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXPIRE'"),
      1,
      'slack:event:Ev123',
      'processing:owner',
      '30',
    );
  });
});
