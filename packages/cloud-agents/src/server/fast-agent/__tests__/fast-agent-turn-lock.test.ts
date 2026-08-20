const { acquireRedisLockMock } = vi.hoisted(() => ({
  acquireRedisLockMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: acquireRedisLockMock,
}));

import {
  acquireFastAgentTurnLock,
  buildFastAgentTurnLockKey,
  FastAgentTurnLockLostError,
} from '../fast-agent-turn-lock';

describe('Fast conversation turn locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes one stable conversation across reply destination changes', () => {
    const original = buildFastAgentTurnLockKey({
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-1' },
    });
    const moved = buildFastAgentTurnLockKey({
      surface: 'discord',
      workspaceId: 'guild-1',
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-2', threadId: 'thread-2' },
    });

    expect(moved).toBe(original);
  });

  it('isolates provider and workspace identities', () => {
    const base = {
      conversationId: 'conversation-1',
      replyTarget: { channelId: 'channel-1', threadId: 'conversation-1' },
    } as const;

    expect(
      new Set([
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'slack',
          workspaceId: 'workspace-1',
        }),
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'slack',
          workspaceId: 'workspace-2',
        }),
        buildFastAgentTurnLockKey({
          ...base,
          surface: 'discord',
          workspaceId: 'workspace-1',
        }),
      ]).size,
    ).toBe(3);
  });

  it('renews an acquired conversation lock until the turn releases it', async () => {
    vi.useFakeTimers();
    try {
      const releaseRedisLock = Object.assign(
        vi.fn().mockResolvedValue(undefined),
        {
          renew: vi.fn().mockResolvedValue(true),
          renewDetailed: vi.fn().mockResolvedValue('renewed'),
        },
      );
      acquireRedisLockMock.mockResolvedValue(releaseRedisLock);

      const releaseTurnLock = await acquireFastAgentTurnLock({
        conversation: {
          surface: 'slack',
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          replyTarget: {
            channelId: 'channel-1',
            threadId: 'conversation-1',
          },
        },
      });

      await vi.advanceTimersByTimeAsync(200_000);
      expect(releaseRedisLock.renewDetailed).toHaveBeenCalledOnce();
      expect(releaseTurnLock?.signal.aborted).toBe(false);

      await releaseTurnLock?.();
      await vi.advanceTimersByTimeAsync(200_000);

      expect(releaseRedisLock.renewDetailed).toHaveBeenCalledOnce();
      expect(releaseRedisLock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the owning turn when lock renewal loses ownership', async () => {
    vi.useFakeTimers();
    try {
      const releaseRedisLock = Object.assign(
        vi.fn().mockResolvedValue(undefined),
        {
          renew: vi.fn().mockResolvedValue(false),
          renewDetailed: vi.fn().mockResolvedValue('lost'),
        },
      );
      acquireRedisLockMock.mockResolvedValue(releaseRedisLock);

      const releaseTurnLock = await acquireFastAgentTurnLock({
        conversation: {
          surface: 'discord',
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          replyTarget: { channelId: 'channel-1' },
        },
      });

      await vi.advanceTimersByTimeAsync(200_000);

      expect(releaseTurnLock?.signal.aborted).toBe(true);
      expect(releaseTurnLock?.signal.reason).toBeInstanceOf(
        FastAgentTurnLockLostError,
      );
      await releaseTurnLock?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
