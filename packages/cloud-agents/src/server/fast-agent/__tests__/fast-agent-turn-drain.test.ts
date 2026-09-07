const { acquireRedisLockMock } = vi.hoisted(() => ({
  acquireRedisLockMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: acquireRedisLockMock,
}));

const { releaseDurableClaimMock } = vi.hoisted(() => ({
  releaseDurableClaimMock: vi.fn(),
}));

vi.mock('../fast-agent-conversation-repository', () => ({
  releaseFastAgentDurableTurnClaim: releaseDurableClaimMock,
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
