const { mockSyncActingUserId, mockSyncRuntimeGitAuthor } = vi.hoisted(() => ({
  mockSyncActingUserId: vi.fn(),
  mockSyncRuntimeGitAuthor: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      syncActingUserId: mockSyncActingUserId,
    },
  },
}));

vi.mock('../../lib/sync-runtime-git-author', () => ({
  syncRuntimeGitAuthor: mockSyncRuntimeGitAuthor,
}));

import {
  prepareActorScopedTurn,
  syncActorScopedTurnState,
} from '../prepare-actor-scoped-turn';

describe('prepareActorScopedTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncActingUserId.mockResolvedValue({
      result: 'updated',
      actingUserId: 'user-2',
    });
    mockSyncRuntimeGitAuthor.mockResolvedValue(undefined);
  });

  it('defers actor-scoped MCP refresh when reconnecting would interrupt a running turn', async () => {
    const refreshActorScopedIntegrations = vi.fn();
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        allowMcpReconnect: false,
        getLastKnownActorUserId: () => 'user-1',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-2' });

    expect(mockSyncActingUserId).toHaveBeenCalledWith({
      runId: 42,
      newUserId: 'user-2',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledWith({
      runId: 42,
      workingDirectory: '/tmp/workspace',
    });
    expect(refreshActorScopedIntegrations).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '[test] Deferring actor-scoped MCP refresh until the queued turn boundary for task run 42',
    );
  });

  it('can defer reconnects until the current turn boundary', async () => {
    const refreshActorScopedIntegrations = vi.fn().mockResolvedValue({
      didChange: true,
      didFail: false,
      didReconnect: true,
      actorChanged: true,
      reason: 'actor-scoped MCP refresh for user-2',
    });

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        deferReconnectUntilTurnBoundary: true,
        logger: {
          info: vi.fn(),
          error: vi.fn(),
        },
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-2' });

    expect(refreshActorScopedIntegrations).toHaveBeenCalledWith('user-2', {
      deferReconnectUntilTurnBoundary: true,
    });
  });

  it('refreshes actor-scoped MCP state immediately when reconnecting is allowed', async () => {
    const refreshActorScopedIntegrations = vi.fn().mockResolvedValue({
      didChange: false,
      didFail: false,
      didReconnect: false,
      actorChanged: false,
    });

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger: {
          info: vi.fn(),
          error: vi.fn(),
        },
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-2' });

    expect(refreshActorScopedIntegrations).toHaveBeenCalledWith('user-2', {
      deferReconnectUntilTurnBoundary: false,
    });
  });

  it('blocks delivery when actor-scoped MCP refresh fails', async () => {
    const refreshActorScopedIntegrations = vi.fn().mockResolvedValue({
      didChange: false,
      didFail: true,
      didReconnect: false,
      actorChanged: true,
    });
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      '[test] Blocking actor-scoped turn delivery because MCP refresh failed for task run 42',
    );
  });

  it('continues delivery when a same-actor MCP recheck fails', async () => {
    const refreshActorScopedIntegrations = vi.fn().mockResolvedValue({
      didChange: false,
      didFail: true,
      didReconnect: false,
      actorChanged: false,
    });
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-2' });

    expect(logger.info).toHaveBeenCalledWith(
      '[test] Actor-scoped MCP refresh failed for task run 42, but the mounted actor is unchanged; continuing with existing MCP state',
    );
  });

  it('skips actor-scoped MCP refresh when actingUserId reconciliation fails', async () => {
    const refreshActorScopedIntegrations = vi.fn();
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    mockSyncActingUserId.mockRejectedValueOnce(new Error('sync failed'));

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toBe(false);

    expect(refreshActorScopedIntegrations).not.toHaveBeenCalled();
    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[test] Failed to reconcile actingUserId for task run 42: sync failed',
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[test] Skipping actor-scoped MCP refresh because actor reconciliation blocked the turn for task run 42',
    );
  });

  it('blocks the turn on a mismatch under the default block policy', async () => {
    // Confused-deputy guard: the sender was never installed as the run's
    // acting user by a trusted server-side writer, so their turn must not
    // run under the current credentials on RPC surfaces.
    const refreshActorScopedIntegrations = vi.fn();
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    mockSyncActingUserId.mockResolvedValueOnce({
      result: 'mismatch',
      actingUserId: 'user-1',
    });

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toBe(false);

    expect(refreshActorScopedIntegrations).not.toHaveBeenCalled();
    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'sender user-2 is not the server-side acting user (user-1)',
      ),
    );
  });

  it('skips the mismatched content and notifies the sender under the skip policy', async () => {
    // Invariant: content only executes when its SENDER equals the identity
    // actor-scoped routes resolve. A mismatched message never runs — not
    // even relabeled to the server actor, since the server actor did not
    // author the instructions. The sender gets a resend notice instead.
    const refreshActorScopedIntegrations = vi.fn();
    const onActorSynced = vi.fn();
    const notifyMismatchSkipped = vi.fn().mockResolvedValue(undefined);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockSyncActingUserId.mockResolvedValueOnce({
      result: 'mismatch',
      actingUserId: 'user-1',
    });

    await expect(
      prepareActorScopedTurn({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        onMismatch: 'skip',
        getLastKnownActorUserId: () => 'user-3',
        onActorSynced,
        notifyMismatchSkipped,
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ skippedMismatch: true });

    // Nothing runs and no local actor state moves: no MCP refresh, no git
    // author change, no marker advance.
    expect(refreshActorScopedIntegrations).not.toHaveBeenCalled();
    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
    expect(onActorSynced).not.toHaveBeenCalled();
    expect(notifyMismatchSkipped).toHaveBeenCalledWith({
      senderUserId: 'user-2',
      serverActorUserId: 'user-1',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping message content for task run 42'),
    );
  });
});

describe('syncActorScopedTurnState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncRuntimeGitAuthor.mockResolvedValue(undefined);
  });

  it('refreshes the git author from the server value on a server-side actor switch', async () => {
    // The server (trusted writers) switched the actor; the worker follows,
    // so commits after the switch carry the new user's identity.
    const onActorSynced = vi.fn();
    const logger = { error: vi.fn() };

    mockSyncActingUserId.mockResolvedValueOnce({
      result: 'updated',
      actingUserId: 'user-2',
    });

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        getLastKnownActorUserId: () => 'user-1',
        onActorSynced,
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(mockSyncActingUserId).toHaveBeenCalledWith({
      runId: 42,
      newUserId: 'user-2',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledWith({
      runId: 42,
      workingDirectory: '/tmp/workspace',
    });
    expect(onActorSynced).toHaveBeenCalledWith('user-2');
  });

  it('skips the git author refresh when the actor is unchanged', async () => {
    const onActorSynced = vi.fn();
    const logger = { error: vi.fn() };

    mockSyncActingUserId.mockResolvedValueOnce({
      result: 'unchanged',
      actingUserId: 'user-2',
    });

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        getLastKnownActorUserId: () => 'user-2',
        onActorSynced,
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
    expect(onActorSynced).not.toHaveBeenCalled();
  });

  it('stops delivery when the task run is gone', async () => {
    const logger = { error: vi.fn() };

    mockSyncActingUserId.mockResolvedValueOnce({ result: 'not-found' });

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
      }),
    ).resolves.toEqual({ ok: false });

    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
  });

  it('does not advance the last-prepared marker when the git author sync fails, so the next turn retries', async () => {
    // If the marker advanced despite the failure, the next reconciliation
    // would report `unchanged` and the run would keep committing as the
    // previous actor's git identity forever.
    const onActorSynced = vi.fn();
    const logger = { error: vi.fn() };
    let lastPrepared: string | null = 'user-1';

    mockSyncActingUserId.mockResolvedValue({
      result: 'updated',
      actingUserId: 'user-2',
    });
    mockSyncRuntimeGitAuthor.mockRejectedValueOnce(new Error('git locked'));

    // First turn: author sync fails, turn still delivers, marker untouched.
    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        getLastKnownActorUserId: () => lastPrepared,
        onActorSynced: (userId) => {
          onActorSynced(userId);
          lastPrepared = userId;
        },
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(onActorSynced).not.toHaveBeenCalled();
    expect(lastPrepared).toBe('user-1');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('will retry on the next turn'),
    );

    // Next turn: the stale marker makes the server report `updated` again;
    // the retry succeeds and only then does the marker advance.
    mockSyncRuntimeGitAuthor.mockResolvedValueOnce(undefined);

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        getLastKnownActorUserId: () => lastPrepared,
        onActorSynced: (userId) => {
          onActorSynced(userId);
          lastPrepared = userId;
        },
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(mockSyncActingUserId).toHaveBeenLastCalledWith({
      runId: 42,
      newUserId: 'user-2',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledTimes(2);
    expect(onActorSynced).toHaveBeenCalledExactlyOnceWith('user-2');
    expect(lastPrepared).toBe('user-2');
  });

  it('repairs a partial git identity when the actor switches back before retry', async () => {
    // The first command in syncRuntimeGitAuthor may update user.email before
    // the user.name command fails. If B then switches back to A, actor
    // equality alone reports `unchanged`; the independent dirty bit must
    // still force both fields to be written again for A.
    const logger = { error: vi.fn() };
    let lastPrepared: string | null = 'user-1';
    let gitAuthorSyncPending = false;
    const stateCallbacks = {
      getLastKnownActorUserId: () => lastPrepared,
      hasPendingGitAuthorSync: () => gitAuthorSyncPending,
      onActorSynced: (userId: string | null) => {
        lastPrepared = userId;
        gitAuthorSyncPending = false;
      },
      onGitAuthorSyncFailed: () => {
        gitAuthorSyncPending = true;
      },
    };

    mockSyncActingUserId
      .mockResolvedValueOnce({
        result: 'updated',
        actingUserId: 'user-2',
      })
      .mockResolvedValueOnce({
        result: 'unchanged',
        actingUserId: 'user-1',
      });
    mockSyncRuntimeGitAuthor
      .mockRejectedValueOnce(new Error('name write failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        ...stateCallbacks,
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(lastPrepared).toBe('user-1');
    expect(gitAuthorSyncPending).toBe(true);

    await expect(
      syncActorScopedTurnState({
        runId: 42,
        targetUserId: 'user-1',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        ...stateCallbacks,
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-1' });

    expect(mockSyncActingUserId).toHaveBeenLastCalledWith({
      runId: 42,
      newUserId: 'user-1',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledTimes(2);
    expect(lastPrepared).toBe('user-1');
    expect(gitAuthorSyncPending).toBe(false);
  });
});
