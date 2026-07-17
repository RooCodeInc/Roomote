import type { RunTokenContext } from '@roomote/types';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockScrubSandboxSecretsBeforeSnapshot } = vi.hoisted(() => ({
  mockScrubSandboxSecretsBeforeSnapshot: vi.fn(),
}));

vi.mock('../../../commands/utils/scrub-sandbox-secrets', () => ({
  scrubSandboxSecretsBeforeSnapshot: mockScrubSandboxSecretsBeforeSnapshot,
}));

function createCaller(
  options: {
    harnessLogger?: Context['harnessLogger'];
    taskRuntime?: Context['taskRuntime'];
  } = {},
) {
  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    harnessLogger: options.harnessLogger,
    taskRuntime: options.taskRuntime,
    auth: {
      runId: 1,
      userId: null,
      principal: 'deployment',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId: 1,
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('scrubSnapshotSecrets procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScrubSandboxSecretsBeforeSnapshot.mockResolvedValue({
      failedSteps: [],
    });
  });

  it('runs the pre-snapshot scrub with the harness logger and task runtime', async () => {
    const harnessLogger = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as NonNullable<Context['harnessLogger']>;
    const taskRuntime = {
      homeDir: '/workspace/.roomote-runtime-home',
      runtimeEnv: { XDG_DATA_HOME: '/task/data' },
    };
    const caller = createCaller({ harnessLogger, taskRuntime });

    const result = await caller.commands.scrubSnapshotSecrets();

    expect(result).toEqual({ success: true });
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledTimes(1);
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledWith(
      harnessLogger,
      taskRuntime,
    );
  });

  it('falls back to console and worker defaults without task runtime context', async () => {
    const caller = createCaller();

    const result = await caller.commands.scrubSnapshotSecrets();

    expect(result).toEqual({ success: true });
    expect(mockScrubSandboxSecretsBeforeSnapshot).toHaveBeenCalledWith(
      console,
      {},
    );
  });

  it('fails the mutation when scrub steps fail so callers do not record success', async () => {
    mockScrubSandboxSecretsBeforeSnapshot.mockResolvedValue({
      failedSteps: ['remove OpenCode credential files'],
    });
    const caller = createCaller();

    await expect(caller.commands.scrubSnapshotSecrets()).rejects.toThrow(
      'Pre-snapshot scrub failed to remove OpenCode credential files',
    );
  });

  it('propagates scrub failures to the caller', async () => {
    mockScrubSandboxSecretsBeforeSnapshot.mockRejectedValue(
      new Error('scrub exploded'),
    );
    const caller = createCaller();

    await expect(caller.commands.scrubSnapshotSecrets()).rejects.toThrow(
      'scrub exploded',
    );
  });
});
