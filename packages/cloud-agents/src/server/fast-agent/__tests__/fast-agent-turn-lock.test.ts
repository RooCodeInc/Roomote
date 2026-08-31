const { acquireRedisLockMock } = vi.hoisted(() => ({
  acquireRedisLockMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: acquireRedisLockMock,
}));

import {
  abortActiveFastAgentTurns,
  acquireFastAgentTurnLock,
  buildFastAgentTurnLockKey,
  FastAgentProcessShutdownError,
  FastAgentTurnLockLostError,
  markFastAgentShutdownCloseoutSettled,
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

  it('aborts and releases an accepted turn on settlement failure', async () => {
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
        surface: 'discord',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        replyTarget: { channelId: 'channel-1' },
      },
    });
    const reason = new Error('settlement failed');

    await releaseTurnLock?.abort(reason);

    expect(releaseTurnLock?.signal.aborted).toBe(true);
    expect(releaseTurnLock?.signal.reason).toBe(reason);
    expect(releaseRedisLock).toHaveBeenCalledOnce();
    await releaseTurnLock?.();
    expect(releaseRedisLock).toHaveBeenCalledOnce();
  });

  it('keeps a queued turn waiting until the conversation lock becomes available', async () => {
    vi.useFakeTimers();
    try {
      const releaseRedisLock = Object.assign(
        vi.fn().mockResolvedValue(undefined),
        {
          renew: vi.fn().mockResolvedValue(true),
          renewDetailed: vi.fn().mockResolvedValue('renewed'),
        },
      );
      let acquisitionAttempts = 0;
      acquireRedisLockMock.mockImplementation(async () => {
        acquisitionAttempts += 1;
        return acquisitionAttempts > 1_201 ? releaseRedisLock : null;
      });

      const acquisition = acquireFastAgentTurnLock({
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
      await vi.advanceTimersByTimeAsync(600_000);
      expect(acquisitionAttempts).toBe(1_201);

      await vi.advanceTimersByTimeAsync(500);

      const releaseTurnLock = await acquisition;
      expect(acquisitionAttempts).toBe(1_202);
      expect(releaseTurnLock).toBeTypeOf('function');
      await releaseTurnLock?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts active turns and rejects a lock acquired during process shutdown', async () => {
    const releaseRedisLocks = Array.from({ length: 2 }, () =>
      Object.assign(vi.fn().mockResolvedValue(undefined), {
        renew: vi.fn().mockResolvedValue(true),
        renewDetailed: vi.fn().mockResolvedValue('renewed'),
      }),
    );
    let finishSecondAcquisition: ((value: unknown) => void) | undefined;
    acquireRedisLockMock
      .mockResolvedValueOnce(releaseRedisLocks[0])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecondAcquisition = resolve;
          }),
      );
    const firstLock = await acquireFastAgentTurnLock({
      conversation: {
        surface: 'slack',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        replyTarget: { channelId: 'channel-1', threadId: 'conversation-1' },
      },
    });
    const queuedAcquisition = acquireFastAgentTurnLock({
      conversation: {
        surface: 'discord',
        workspaceId: 'workspace-2',
        conversationId: 'conversation-2',
        replyTarget: { channelId: 'channel-2' },
      },
    });
    const shutdown = new FastAgentProcessShutdownError('SIGTERM');

    let shutdownSettled = false;
    const aborting = abortActiveFastAgentTurns(shutdown).finally(() => {
      shutdownSettled = true;
    });
    await vi.waitFor(() => {
      expect(firstLock?.signal.reason).toBe(shutdown);
    });
    expect(shutdownSettled).toBe(false);
    expect(releaseRedisLocks[0]).not.toHaveBeenCalled();
    markFastAgentShutdownCloseoutSettled(firstLock!.signal);
    await expect(aborting).resolves.toBe(1);
    expect(releaseRedisLocks[0]).toHaveBeenCalledOnce();
    await firstLock?.();
    finishSecondAcquisition?.(releaseRedisLocks[1]);

    await expect(queuedAcquisition).resolves.toBeNull();
    for (const releaseRedisLock of releaseRedisLocks) {
      expect(releaseRedisLock).toHaveBeenCalledOnce();
    }
    await expect(
      acquireFastAgentTurnLock({
        conversation: {
          surface: 'slack',
          workspaceId: 'workspace-3',
          conversationId: 'conversation-3',
          replyTarget: { channelId: 'channel-3', threadId: 'conversation-3' },
        },
      }),
    ).resolves.toBeNull();
  });
});
