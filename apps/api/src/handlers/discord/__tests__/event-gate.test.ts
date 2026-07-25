const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mocks.eval }),
}));

import {
  claimDiscordApiEvent,
  completeDiscordApiEvent,
  releaseDiscordApiEvent,
  renewDiscordApiEvent,
} from '../event-gate.js';

describe('Discord API event gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['processing', 'completed'] as const)(
    'preserves the %s state returned atomically by Redis',
    async (status) => {
      mocks.eval.mockResolvedValue(status);

      await expect(
        claimDiscordApiEvent({
          eventType: 'MESSAGE_CREATE',
          eventId: 'message-1',
        }),
      ).resolves.toEqual({ status });
    },
  );

  it('returns an ownership token for a newly claimed event', async () => {
    mocks.eval.mockResolvedValue('claimed');

    const claim = await claimDiscordApiEvent({
      eventType: 'INTERACTION_CREATE',
      eventId: 'interaction-1',
    });

    expect(claim).toEqual({
      status: 'claimed',
      token: expect.stringMatching(/^processing:/u),
    });
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("return 'claimed'"),
      1,
      'discord:api:event:INTERACTION_CREATE:interaction-1',
      claim.status === 'claimed' ? claim.token : undefined,
      '300',
    );
  });

  it('completes and releases only with the lease owner token', async () => {
    mocks.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const event = {
      eventType: 'MESSAGE_CREATE',
      eventId: 'message-1',
      token: 'processing:owner',
    };

    await expect(completeDiscordApiEvent(event)).resolves.toBe(true);
    await expect(releaseDiscordApiEvent(event)).resolves.toBe(false);

    expect(mocks.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("'done'"),
      1,
      'discord:api:event:MESSAGE_CREATE:message-1',
      'processing:owner',
      '604800',
    );
    expect(mocks.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("redis.call('DEL'"),
      1,
      'discord:api:event:MESSAGE_CREATE:message-1',
      'processing:owner',
    );
  });

  it('renews only the lease owner token', async () => {
    mocks.eval.mockResolvedValue(1);

    await expect(
      renewDiscordApiEvent({
        eventType: 'MESSAGE_CREATE',
        eventId: 'message-1',
        token: 'processing:owner',
      }),
    ).resolves.toBe(true);

    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXPIRE'"),
      1,
      'discord:api:event:MESSAGE_CREATE:message-1',
      'processing:owner',
      '300',
    );
  });
});
