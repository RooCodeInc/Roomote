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

import { prepareActorScopedTurn } from '../prepare-actor-scoped-turn';

describe('prepareActorScopedTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncActingUserId.mockResolvedValue('updated');
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
        logger,
        refreshActorScopedIntegrations,
      }),
    ).resolves.toBe(true);

    expect(mockSyncActingUserId).toHaveBeenCalledWith({
      cloudJobId: 42,
      newUserId: 'user-2',
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
    ).resolves.toBe(true);

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
    ).resolves.toBe(true);

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
    ).resolves.toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      '[test] Actor-scoped MCP refresh failed for cloud job 42, but the mounted actor is unchanged; continuing with existing MCP state',
    );
  });

  it('skips actor-scoped MCP refresh when actingUserId sync fails', async () => {
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
      '[test] Failed to update actingUserId for cloud job 42: sync failed',
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[test] Skipping actor-scoped MCP refresh because actingUserId was not updated for cloud job 42',
    );
  });
});
