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
  markFastAgentShutdownCloseoutPending,
  markFastAgentShutdownCloseoutSettled,
  registerFastAgentTurnActivity,
} from '../fast-agent-turn-lock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

  it.each(['release', 'abort', 'shutdown'] as const)(
    'drains activity before %s releases Redis, independently of inference',
    async (mode) => {
      const releaseRedisLock = Object.assign(
        vi.fn().mockResolvedValue(undefined),
        {
          renewDetailed: vi.fn().mockResolvedValue('renewed'),
        },
      );
      acquireRedisLockMock.mockResolvedValue(releaseRedisLock);
      const lock = (await acquireFastAgentTurnLock({
        conversation: {
          surface: 'slack',
          workspaceId: 'workspace-1',
          conversationId: 'conversation-1',
          replyTarget: { channelId: 'channel-1', threadId: 'conversation-1' },
        },
      }))!;
      const cleanup = deferred<void>();
      const activity = {
        settle: vi.fn(() => cleanup.promise),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      registerFastAgentTurnActivity(lock.signal, activity);
      if (mode === 'shutdown')
        markFastAgentShutdownCloseoutPending(lock.signal);
      const releasing =
        mode === 'release'
          ? lock()
          : mode === 'abort'
            ? lock.abort(new Error('cancelled'))
            : lock.abortForShutdown(
                new FastAgentProcessShutdownError('SIGTERM'),
              );
      if (mode === 'shutdown') {
        expect(releaseRedisLock).not.toHaveBeenCalled();
        markFastAgentShutdownCloseoutSettled(lock.signal);
        await Promise.resolve();
      }
      expect(activity.settle).toHaveBeenCalledOnce();
      expect(releaseRedisLock).not.toHaveBeenCalled();
      let duplicateFinished = false;
      const duplicate = lock().then(() => {
        duplicateFinished = true;
      });
      await Promise.resolve();
      expect(duplicateFinished).toBe(false);
      cleanup.resolve();
      await Promise.all([releasing, duplicate]);
      expect(releaseRedisLock).toHaveBeenCalledOnce();
      expect(activity.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        releaseRedisLock.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('fences a stuck cleanup at its deadline and disposes late registrations after release', async () => {
    vi.useFakeTimers();
    try {
      const releaseRedisLock = Object.assign(
        vi.fn().mockResolvedValue(undefined),
        { renewDetailed: vi.fn().mockResolvedValue('renewed') },
      );
      acquireRedisLockMock.mockResolvedValue(releaseRedisLock);
      const lock = (await acquireFastAgentTurnLock({
        conversation: {
          surface: 'discord',
          workspaceId: 'w',
          conversationId: 'c',
          replyTarget: { channelId: 'c' },
        },
      }))!;
      const activity = {
        settle: vi.fn(() => new Promise<void>(() => {})),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      registerFastAgentTurnActivity(lock.signal, activity);
      const aborting = lock.abort();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(releaseRedisLock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await aborting;
      expect(activity.dispose).toHaveBeenCalledOnce();
      expect(releaseRedisLock).toHaveBeenCalledOnce();
      const late = {
        settle: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      registerFastAgentTurnActivity(lock.signal, late);
      expect(late.dispose).toHaveBeenCalledOnce();
      expect(late.settle).not.toHaveBeenCalled();
      await lock();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'disposes on renewal loss even after an earlier abort (%s)',
    async (alreadyAborted) => {
      vi.useFakeTimers();
      try {
        const renewal = deferred<'lost'>();
        const releaseRedisLock = Object.assign(
          vi.fn().mockResolvedValue(undefined),
          { renewDetailed: vi.fn(() => renewal.promise) },
        );
        acquireRedisLockMock.mockResolvedValue(releaseRedisLock);
        const lock = (await acquireFastAgentTurnLock({
          conversation: {
            surface: 'discord',
            workspaceId: 'w',
            conversationId: 'c',
            replyTarget: { channelId: 'c' },
          },
        }))!;
        const cleanup = deferred<void>();
        const activity = {
          settle: vi.fn(() => cleanup.promise),
          dispose: vi.fn().mockResolvedValue(undefined),
        };
        registerFastAgentTurnActivity(lock.signal, activity);
        await vi.advanceTimersByTimeAsync(200_000);
        const aborting = alreadyAborted
          ? lock.abort(new Error('cancelled'))
          : undefined;
        renewal.resolve('lost');
        await vi.advanceTimersByTimeAsync(0);
        expect(activity.dispose).toHaveBeenCalledOnce();
        if (!alreadyAborted) expect(activity.settle).not.toHaveBeenCalled();
        cleanup.resolve();
        await aborting;
        await lock();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('unregisters each completed invocation when a queue reuses its lock', async () => {
    const releaseRedisLock = Object.assign(
      vi.fn().mockResolvedValue(undefined),
      { renewDetailed: vi.fn().mockResolvedValue('renewed') },
    );
    acquireRedisLockMock.mockResolvedValue(releaseRedisLock);
    const lock = (await acquireFastAgentTurnLock({
      conversation: {
        surface: 'discord',
        workspaceId: 'w',
        conversationId: 'c',
        replyTarget: { channelId: 'c' },
      },
    }))!;
    const first = {
      settle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const unregister = registerFastAgentTurnActivity(lock.signal, first);
    unregister?.();
    const next = {
      settle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    registerFastAgentTurnActivity(lock.signal, next);
    unregister?.();
    await lock.abort();
    expect(first.settle).not.toHaveBeenCalled();
    expect(next.settle).toHaveBeenCalledOnce();
    await lock();
  });

  it('releases pre-answer locks while waiting for active answer closeout during shutdown', async () => {
    const releaseRedisLocks = Array.from({ length: 3 }, () =>
      Object.assign(vi.fn().mockResolvedValue(undefined), {
        renew: vi.fn().mockResolvedValue(true),
        renewDetailed: vi.fn().mockResolvedValue('renewed'),
      }),
    );
    let finishSecondAcquisition: ((value: unknown) => void) | undefined;
    acquireRedisLockMock
      .mockResolvedValueOnce(releaseRedisLocks[0])
      .mockResolvedValueOnce(releaseRedisLocks[1])
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
    const preAnswerLock = await acquireFastAgentTurnLock({
      conversation: {
        surface: 'discord',
        workspaceId: 'workspace-2',
        conversationId: 'conversation-2',
        replyTarget: { channelId: 'channel-2' },
      },
    });
    markFastAgentShutdownCloseoutPending(firstLock!.signal);
    const queuedAcquisition = acquireFastAgentTurnLock({
      conversation: {
        surface: 'slack',
        workspaceId: 'workspace-3',
        conversationId: 'conversation-3',
        replyTarget: { channelId: 'channel-3', threadId: 'conversation-3' },
      },
    });
    const shutdown = new FastAgentProcessShutdownError('SIGTERM');

    let shutdownSettled = false;
    const aborting = abortActiveFastAgentTurns(shutdown).finally(() => {
      shutdownSettled = true;
    });
    await vi.waitFor(() => {
      expect(firstLock?.signal.reason).toBe(shutdown);
      expect(preAnswerLock?.signal.reason).toBe(shutdown);
      expect(releaseRedisLocks[1]).toHaveBeenCalledOnce();
    });
    expect(shutdownSettled).toBe(false);
    expect(releaseRedisLocks[0]).not.toHaveBeenCalled();
    markFastAgentShutdownCloseoutSettled(firstLock!.signal);
    await expect(aborting).resolves.toBe(2);
    expect(releaseRedisLocks[0]).toHaveBeenCalledOnce();
    await firstLock?.();
    await preAnswerLock?.();
    finishSecondAcquisition?.(releaseRedisLocks[2]);

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
