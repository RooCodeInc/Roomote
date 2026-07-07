import {
  runTaskSuggestionReactionContention,
  type TaskSuggestionReactionContentionState,
  type TaskSuggestionReactionState,
} from './task-suggestion-reaction-contention.js';

function createClaimedState(): TaskSuggestionReactionState {
  return {
    taskId: null,
    launchClaimedAt: new Date('2026-03-17T00:00:00.000Z'),
    launchedThreadTs: null,
  };
}

function createClearedState(): TaskSuggestionReactionState {
  return {
    taskId: null,
    launchClaimedAt: null,
    launchedThreadTs: null,
  };
}

function createHandledState(): TaskSuggestionReactionState {
  return {
    taskId: 'task-123',
    launchClaimedAt: null,
    launchedThreadTs: '999.000',
  };
}

function createLockHandle(renewed = true) {
  return Object.assign(vi.fn().mockResolvedValue(undefined), {
    renew: vi.fn().mockResolvedValue(renewed),
  });
}

describe('runTaskSuggestionReactionContention', () => {
  it('retries launch after claim handoff while the contender still holds the lock', async () => {
    const transitions: TaskSuggestionReactionContentionState[] = [];
    const lockHandle = createLockHandle();
    const acquireLock = vi.fn().mockResolvedValue(lockHandle);
    const launch = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const getState = vi
      .fn()
      .mockResolvedValueOnce(createClaimedState())
      .mockResolvedValueOnce(createClaimedState())
      .mockResolvedValueOnce(createClearedState());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runTaskSuggestionReactionContention({
      acquireLock,
      launch,
      getState,
      maxAttempts: 2,
      pollIntervalMs: 400,
      sleep,
      onStateTransition: (state) => {
        transitions.push(state);
      },
    });

    expect(result).toBe('handled');
    expect(transitions).toEqual(['claimed', 'claim-cleared', 'handled']);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(lockHandle.renew).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(lockHandle).toHaveBeenCalledTimes(1);
  });

  it('returns handled when an earlier launcher finishes before the lock is acquired', async () => {
    const transitions: TaskSuggestionReactionContentionState[] = [];
    const acquireLock = vi.fn().mockResolvedValue(null);
    const getState = vi.fn().mockResolvedValue(createHandledState());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runTaskSuggestionReactionContention({
      acquireLock,
      launch: vi.fn(),
      getState,
      maxAttempts: 2,
      pollIntervalMs: 400,
      sleep,
      onStateTransition: (state) => {
        transitions.push(state);
      },
    });

    expect(result).toBe('handled');
    expect(transitions).toEqual(['handled']);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('times out when the launch claim never clears', async () => {
    const transitions: TaskSuggestionReactionContentionState[] = [];
    const lockHandle = createLockHandle();
    const getState = vi
      .fn()
      .mockResolvedValueOnce(createClaimedState())
      .mockResolvedValueOnce(createClaimedState())
      .mockResolvedValueOnce(createClaimedState())
      .mockResolvedValueOnce(createClaimedState());
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runTaskSuggestionReactionContention({
      acquireLock: vi.fn().mockResolvedValue(lockHandle),
      launch: vi.fn().mockResolvedValue(false),
      getState,
      maxAttempts: 2,
      pollIntervalMs: 400,
      sleep,
      onStateTransition: (state) => {
        transitions.push(state);
      },
    });

    expect(result).toBe('timed-out');
    expect(transitions).toEqual(['claimed', 'timed-out']);
    expect(lockHandle.renew).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(lockHandle).toHaveBeenCalledTimes(1);
  });

  it('returns lock-lost when the contender cannot renew the lock while waiting', async () => {
    const transitions: TaskSuggestionReactionContentionState[] = [];
    const lockHandle = createLockHandle(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runTaskSuggestionReactionContention({
      acquireLock: vi.fn().mockResolvedValue(lockHandle),
      launch: vi.fn().mockResolvedValue(false),
      getState: vi
        .fn()
        .mockResolvedValueOnce(createClaimedState())
        .mockResolvedValueOnce(createClaimedState()),
      maxAttempts: 2,
      pollIntervalMs: 400,
      sleep,
      onStateTransition: (state) => {
        transitions.push(state);
      },
    });

    expect(result).toBe('lock-lost');
    expect(transitions).toEqual(['claimed', 'lock-lost']);
    expect(lockHandle.renew).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(lockHandle).toHaveBeenCalledTimes(1);
  });
});
