const { acquireRedisLockMock, redisExistsMock } = vi.hoisted(() => ({
  acquireRedisLockMock: vi.fn(),
  redisExistsMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: acquireRedisLockMock,
  getRedis: () => ({ exists: redisExistsMock }),
}));

const { releaseDurableClaimMock, markShutdownMock } = vi.hoisted(() => ({
  releaseDurableClaimMock: vi.fn(),
  markShutdownMock: vi.fn(),
}));

vi.mock('../fast-agent-conversation-repository', () => ({
  releaseFastAgentDurableTurnClaim: releaseDurableClaimMock,
  markFastAgentDurableTurnShutdown: markShutdownMock,
}));

type TurnLockModule = typeof import('../fast-agent-turn-lock');

const conversation = {
  surface: 'slack',
  workspaceId: 'workspace-1',
  conversationId: 'conversation-1',
  replyTarget: { channelId: 'channel-1', threadId: 'conversation-1' },
} as const;

const otherConversation = {
  surface: 'slack',
  workspaceId: 'workspace-1',
  conversationId: 'conversation-2',
  replyTarget: { channelId: 'channel-1', threadId: 'conversation-2' },
} as const;

function buildRedisLock() {
  return Object.assign(vi.fn().mockResolvedValue(undefined), {
    renew: vi.fn().mockResolvedValue(true),
    renewDetailed: vi.fn().mockResolvedValue('renewed'),
  });
}

// The drain flag is module-global by design (a draining process never
// accepts turns again), so every test runs against a fresh module instance.
describe('Fast turn shutdown drain', () => {
  let turnLock: TurnLockModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    acquireRedisLockMock.mockImplementation(async () => buildRedisLock());
    turnLock = await import('../fast-agent-turn-lock');
  });

  it('refuses new admissions during drain without aborting active turns', async () => {
    const activeLock = await turnLock.acquireFastAgentTurnLock({
      conversation,
    });
    expect(activeLock).not.toBeNull();

    turnLock.beginFastAgentTurnDrain(
      new turnLock.FastAgentProcessShutdownError('SIGTERM'),
    );

    await expect(
      turnLock.acquireFastAgentTurnLock({ conversation: otherConversation }),
    ).resolves.toBeNull();
    expect(activeLock!.signal.aborted).toBe(false);

    await activeLock!();
  });

  it('resolves the drain wait as soon as the last active turn settles', async () => {
    await expect(
      turnLock.waitForActiveFastAgentTurnsToSettle(5_000),
    ).resolves.toBe(0);

    const activeLock = await turnLock.acquireFastAgentTurnLock({
      conversation,
    });
    let settled = false;
    const waiting = turnLock
      .waitForActiveFastAgentTurnsToSettle(5_000)
      .then((remaining) => {
        settled = true;
        return remaining;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await activeLock!();
    await expect(waiting).resolves.toBe(0);
  });

  it('reports the stragglers still active at the drain deadline', async () => {
    const straggler = await turnLock.acquireFastAgentTurnLock({ conversation });

    await expect(
      turnLock.waitForActiveFastAgentTurnsToSettle(20),
    ).resolves.toBe(1);
    expect(straggler!.signal.aborted).toBe(false);

    await straggler!();
  });

  it('releases the durable claim of every bound turn during shutdown', async () => {
    releaseDurableClaimMock.mockResolvedValue(true);
    const resume = vi.fn().mockResolvedValue(undefined);
    const boundLock = await turnLock.acquireFastAgentTurnLock({ conversation });
    boundLock!.durableRowId = 'durable-row-1';
    boundLock!.durableResume = resume;
    const unboundLock = await turnLock.acquireFastAgentTurnLock({
      conversation: otherConversation,
    });

    await expect(
      turnLock.abortActiveFastAgentTurns(
        new turnLock.FastAgentProcessShutdownError('SIGTERM'),
      ),
    ).resolves.toBe(2);

    // A turn interrupted before it reached its own abort handling still gets
    // its row handed to the queue and the queue woken; unbound turns are
    // untouched.
    expect(releaseDurableClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseDurableClaimMock).toHaveBeenCalledWith('durable-row-1');
    expect(resume).toHaveBeenCalledOnce();
    await boundLock!();
    await unboundLock!();
  });

  it('does not wake the queue when the shutdown release found no pending row', async () => {
    releaseDurableClaimMock.mockResolvedValue(false);
    const resume = vi.fn().mockResolvedValue(undefined);
    const settledLock = await turnLock.acquireFastAgentTurnLock({
      conversation,
    });
    settledLock!.durableRowId = 'durable-row-2';
    settledLock!.durableResume = resume;

    await turnLock.abortActiveFastAgentTurns(
      new turnLock.FastAgentProcessShutdownError('SIGTERM'),
    );

    expect(resume).not.toHaveBeenCalled();
    await settledLock!();
  });

  it('stamps every bound durable turn with the stop signal, and only those', async () => {
    markShutdownMock.mockResolvedValue(true);
    const boundLock = await turnLock.acquireFastAgentTurnLock({ conversation });
    boundLock!.durableRowId = 'durable-row-1';
    const unboundLock = await turnLock.acquireFastAgentTurnLock({
      conversation: otherConversation,
    });

    await expect(
      turnLock.markActiveFastAgentTurnsShutdown({ lockTtlSeconds: 80 }),
    ).resolves.toBe(1);

    expect(markShutdownMock).toHaveBeenCalledTimes(1);
    expect(markShutdownMock).toHaveBeenCalledWith('durable-row-1');
    // The bound turn's lock is shortened (ownership-checked, through the
    // lock's own renew script) so a kill cannot pin the conversation for the
    // full TTL; the unbound turn's lock is untouched.
    const [boundRedisLock, unboundRedisLock] = await Promise.all(
      acquireRedisLockMock.mock.results.map((result) => result.value),
    );
    expect(boundRedisLock.renewDetailed).toHaveBeenCalledWith(80);
    expect(unboundRedisLock.renewDetailed).not.toHaveBeenCalled();
    // The stamp is evidence only: nothing is aborted or released by it.
    expect(boundLock!.signal.aborted).toBe(false);
    await boundLock!();
    await unboundLock!();
  });

  it('keeps going when a shutdown stamp fails', async () => {
    markShutdownMock.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boundLock = await turnLock.acquireFastAgentTurnLock({ conversation });
    boundLock!.durableRowId = 'durable-row-2';

    await expect(turnLock.markActiveFastAgentTurnsShutdown()).resolves.toBe(1);

    expect(warn).toHaveBeenCalledOnce();
    const [redisLock] = await Promise.all(
      acquireRedisLockMock.mock.results.map((result) => result.value),
    );
    expect(redisLock.renewDetailed).not.toHaveBeenCalled();
    warn.mockRestore();
    await boundLock!();
  });

  it('stamps and shortens a row bound after the stop signal', async () => {
    markShutdownMock.mockResolvedValue(true);
    const lateLock = await turnLock.acquireFastAgentTurnLock({ conversation });
    turnLock.beginFastAgentTurnDrain(
      new turnLock.FastAgentProcessShutdownError('SIGTERM'),
    );
    // The one-time pass finds nothing bound yet.
    await expect(
      turnLock.markActiveFastAgentTurnsShutdown({ lockTtlSeconds: 80 }),
    ).resolves.toBe(0);
    expect(markShutdownMock).not.toHaveBeenCalled();

    // A worker that claimed its row before the signal binds it during the
    // drain: the binding itself stamps and shortens, so an immediate kill
    // still leaves evidence and a short lock.
    const resume = vi.fn().mockResolvedValue(undefined);
    await turnLock.bindFastAgentTurnLockDurableRow(lateLock!, {
      rowId: 'durable-row-late',
      resume,
    });
    expect(lateLock!.durableRowId).toBe('durable-row-late');
    expect(lateLock!.durableResume).toBe(resume);
    expect(markShutdownMock).toHaveBeenCalledWith('durable-row-late');
    const [redisLock] = await Promise.all(
      acquireRedisLockMock.mock.results.map((result) => result.value),
    );
    expect(redisLock.renewDetailed).toHaveBeenCalledWith(80);
    await lateLock!();
  });

  it('binds without stamping while no stop signal has arrived', async () => {
    const lock = await turnLock.acquireFastAgentTurnLock({ conversation });
    await turnLock.bindFastAgentTurnLockDurableRow(lock!, {
      rowId: 'durable-row-calm',
      resume: vi.fn().mockResolvedValue(undefined),
    });
    expect(lock!.durableRowId).toBe('durable-row-calm');
    expect(markShutdownMock).not.toHaveBeenCalled();
    await lock!();
  });

  it('reports whether a conversation turn lock is currently held', async () => {
    redisExistsMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(turnLock.isFastAgentTurnLockHeld(conversation)).resolves.toBe(
      true,
    );
    await expect(turnLock.isFastAgentTurnLockHeld(conversation)).resolves.toBe(
      false,
    );
    expect(redisExistsMock).toHaveBeenCalledWith(
      'fast-agent:conversation-lock:slack:workspace-1:conversation-1',
    );
  });

  it('aborts stragglers with the reason the drain began with', async () => {
    const straggler = await turnLock.acquireFastAgentTurnLock({ conversation });
    const drainReason = new turnLock.FastAgentProcessShutdownError('SIGTERM');

    turnLock.beginFastAgentTurnDrain(drainReason);
    await expect(
      turnLock.abortActiveFastAgentTurns(
        new turnLock.FastAgentProcessShutdownError('SIGINT'),
      ),
    ).resolves.toBe(1);

    expect(straggler!.signal.aborted).toBe(true);
    expect(straggler!.signal.reason).toBe(drainReason);
    await straggler!();
  });
});
