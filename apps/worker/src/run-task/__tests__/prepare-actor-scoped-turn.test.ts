const { mockSyncActingUserId, mockSyncRuntimeGitAuthor } = vi.hoisted(() => ({
  mockSyncActingUserId: vi.fn(),
  mockSyncRuntimeGitAuthor: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
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
        cloudJobId: 42,
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
      cloudJobId: 42,
      newUserId: 'user-2',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledWith({
      cloudJobId: 42,
      workingDirectory: '/tmp/workspace',
    });
    expect(refreshActorScopedIntegrations).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '[test] Deferring actor-scoped MCP refresh until the queued turn boundary for cloud job 42',
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
        cloudJobId: 42,
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
        cloudJobId: 42,
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
        cloudJobId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      '[test] Blocking actor-scoped turn delivery because MCP refresh failed for cloud job 42',
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
        cloudJobId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-2' });

    expect(logger.info).toHaveBeenCalledWith(
      '[test] Actor-scoped MCP refresh failed for cloud job 42, but the mounted actor is unchanged; continuing with existing MCP state',
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
        cloudJobId: 42,
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
      '[test] Failed to reconcile actingUserId for cloud job 42: sync failed',
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[test] Skipping actor-scoped MCP refresh because actor reconciliation blocked the turn for cloud job 42',
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
        cloudJobId: 42,
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

  it('follows the server actor on a mismatch under the follow-server policy', async () => {
    // Queued/polled deliveries cannot converge by requeueing, so the turn
    // runs as the server actor: integrations refresh for the server value
    // and the caller attributes the turn to it.
    const refreshActorScopedIntegrations = vi.fn().mockResolvedValue({
      didChange: true,
      didFail: false,
      didReconnect: true,
      actorChanged: true,
    });
    const onActorSynced = vi.fn();
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
        cloudJobId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        onMismatch: 'follow-server',
        getLastKnownActorUserId: () => 'user-3',
        onActorSynced,
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toEqual({ effectiveUserId: 'user-1' });

    // Integrations and git author follow the SERVER value, not the sender.
    expect(refreshActorScopedIntegrations).toHaveBeenCalledWith('user-1', {
      deferReconnectUntilTurnBoundary: false,
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledWith({
      cloudJobId: 42,
      workingDirectory: '/tmp/workspace',
    });
    expect(onActorSynced).toHaveBeenCalledWith('user-1');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'as server actor user-1 instead of sender user-2',
      ),
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
        cloudJobId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        getLastKnownActorUserId: () => 'user-1',
        onActorSynced,
        logger,
      }),
    ).resolves.toEqual({ ok: true, effectiveUserId: 'user-2' });

    expect(mockSyncActingUserId).toHaveBeenCalledWith({
      cloudJobId: 42,
      newUserId: 'user-2',
      lastKnownUserId: 'user-1',
    });
    expect(mockSyncRuntimeGitAuthor).toHaveBeenCalledWith({
      cloudJobId: 42,
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
        cloudJobId: 42,
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

  it('stops delivery when the cloud job is gone', async () => {
    const logger = { error: vi.fn() };

    mockSyncActingUserId.mockResolvedValueOnce({ result: 'not-found' });

    await expect(
      syncActorScopedTurnState({
        cloudJobId: 42,
        targetUserId: 'user-2',
        workingDirectory: '/tmp/workspace',
        logPrefix: '[test]',
        logger,
      }),
    ).resolves.toEqual({ ok: false });

    expect(mockSyncRuntimeGitAuthor).not.toHaveBeenCalled();
  });
});
