import type { RunTokenContext } from '@roomote/types';

import {
  engageCredentialWriteBarrier,
  isCredentialWriteBarrierEngaged,
  resetCredentialWriteBarrierForTesting,
} from '../../../lib/credential-write-barrier';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockRefreshGitHubToken, mockApplyDeploymentEnvVarsReload } = vi.hoisted(
  () => ({
    mockRefreshGitHubToken: vi.fn(),
    mockApplyDeploymentEnvVarsReload: vi.fn(),
  }),
);

vi.mock('../../../run-task/polling/github-token-refresh', () => ({
  refreshGitHubToken: mockRefreshGitHubToken,
}));

vi.mock('../reloadDeploymentEnvVars', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../reloadDeploymentEnvVars')>();

  return {
    ...actual,
    applyDeploymentEnvVarsReload: mockApplyDeploymentEnvVarsReload,
  };
});

function createCaller(options: { workerEnv?: unknown } = { workerEnv: {} }) {
  const ctx = {
    workingDirectory: '/tmp',
    harness: { isConnected: true },
    workerEnv: options.workerEnv,
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
      success: true,
      names: ['OPENAI_API_KEY'],
    });
  });

  it('releases the barrier and re-materializes token files and env vars', async () => {
    await engageCredentialWriteBarrier();
    const caller = createCaller();

    const result = await caller.commands.restoreScrubbedCredentials();

    expect(result).toEqual({ success: true });
    expect(isCredentialWriteBarrierEngaged()).toBe(false);
    expect(mockRefreshGitHubToken).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1 }),
    );
    expect(mockApplyDeploymentEnvVarsReload).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1 }),
    );
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
