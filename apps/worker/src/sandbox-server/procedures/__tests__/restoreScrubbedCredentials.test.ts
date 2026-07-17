import type { RunTokenContext } from '@roomote/types';

import {
  engageCredentialWriteBarrier,
  isCredentialWriteBarrierEngaged,
  resetCredentialWriteBarrierForTesting,
} from '../../../lib/credential-write-barrier';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const {
  mockRefreshGitHubToken,
  mockApplyDeploymentEnvVarsReload,
  mockRematerializeOpenCodeCredentialFiles,
} = vi.hoisted(() => ({
  mockRefreshGitHubToken: vi.fn(),
  mockApplyDeploymentEnvVarsReload: vi.fn(),
  mockRematerializeOpenCodeCredentialFiles: vi.fn(),
}));

vi.mock('../../../run-task/polling/github-token-refresh', () => ({
  refreshGitHubToken: mockRefreshGitHubToken,
}));

vi.mock('../../../run-task/agent-home', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../run-task/agent-home')>();

  return {
    ...actual,
    rematerializeOpenCodeCredentialFiles:
      mockRematerializeOpenCodeCredentialFiles,
  };
});

vi.mock('../reloadDeploymentEnvVars', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../reloadDeploymentEnvVars')>();

  return {
    ...actual,
    applyDeploymentEnvVarsReload: mockApplyDeploymentEnvVarsReload,
  };
});

function createCaller(
  options: { workerEnv?: unknown; taskRuntime?: Context['taskRuntime'] } = {
    workerEnv: {},
  },
) {
  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    workerEnv: options.workerEnv,
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

describe('restoreScrubbedCredentials procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCredentialWriteBarrierForTesting();
    mockRefreshGitHubToken.mockResolvedValue({
      nextRefreshAtMs: Date.now() + 60_000,
      source: 'app',
      expiresAt: null,
    });
    mockApplyDeploymentEnvVarsReload.mockResolvedValue({
      names: ['OPENAI_API_KEY'],
      envVars: { OPENAI_API_KEY: 'fresh-openai-key' },
    });
    mockRematerializeOpenCodeCredentialFiles.mockReturnValue({
      failedSteps: [],
    });
  });

  it('releases the barrier and re-materializes token files, env vars, and OpenCode credentials', async () => {
    await engageCredentialWriteBarrier();
    const caller = createCaller({
      workerEnv: {},
      taskRuntime: {
        homeDir: '/workspace/.roomote-runtime-home',
        runtimeEnv: {
          XDG_DATA_HOME: '/task/data',
          OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"old"}}',
        },
      },
    });
    mockApplyDeploymentEnvVarsReload.mockResolvedValue({
      names: ['OPENCODE_AUTH_CONTENT'],
      envVars: {
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"fresh"}}',
      },
    });

    const result = await caller.commands.restoreScrubbedCredentials();

    expect(result).toEqual({ success: true });
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
    expect(mockRefreshGitHubToken).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1 }),
    );
    expect(mockApplyDeploymentEnvVarsReload).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1 }),
    );
    expect(mockRematerializeOpenCodeCredentialFiles).toHaveBeenCalledWith({
      homeDir: '/workspace/.roomote-runtime-home',
      runtimeEnv: {
        XDG_DATA_HOME: '/task/data',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"oauth","access":"fresh"}}',
      },
      logger: console,
    });
  });

  it('fails when rewriting OpenCode credential files fails', async () => {
    mockRematerializeOpenCodeCredentialFiles.mockReturnValue({
      failedSteps: ['rewrite OpenCode auth file'],
    });
    const caller = createCaller();

    await expect(caller.commands.restoreScrubbedCredentials()).rejects.toThrow(
      'rewrite OpenCode auth file',
    );
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
  });

  it('fails when the token refresh could not produce a token', async () => {
    mockRefreshGitHubToken.mockResolvedValue({
      nextRefreshAtMs: Date.now() + 60_000,
      source: null,
      expiresAt: null,
    });
    const caller = createCaller();

    await expect(caller.commands.restoreScrubbedCredentials()).rejects.toThrow(
      'refresh source-control token files',
    );
    // The barrier is still released so scheduled refreshes can recover later.
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
  });

  it('fails when the env reload fails but still releases the barrier', async () => {
    await engageCredentialWriteBarrier();
    mockApplyDeploymentEnvVarsReload.mockRejectedValue(
      new Error('reload exploded'),
    );
    const caller = createCaller();

    await expect(caller.commands.restoreScrubbedCredentials()).rejects.toThrow(
      'reload deployment env vars',
    );
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
    expect(mockRefreshGitHubToken).toHaveBeenCalled();
  });
});
