const { acquireRedisLockMock } = vi.hoisted(() => ({
  acquireRedisLockMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: acquireRedisLockMock,
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
