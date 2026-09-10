import type { RunTokenContext } from '@roomote/types';

import { WorkerEnv } from '../../../env';
import {
  engageCredentialWriteBarrier,
  resetCredentialWriteBarrierForTesting,
} from '../../../lib/credential-write-barrier';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockGetResolvedRuntimeEnvVars, mockFindFirstById, mockInjectEnvVars } =
  vi.hoisted(() => ({
    mockGetResolvedRuntimeEnvVars: vi.fn(),
    mockFindFirstById: vi.fn(),
    mockInjectEnvVars: vi.fn(),
  }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      getResolvedRuntimeEnvVars: mockGetResolvedRuntimeEnvVars,
      findFirstById: mockFindFirstById,
    },
  },
}));

vi.mock('../../../commands/utils/env-vars', () => ({
  injectEnvVars: mockInjectEnvVars,
}));

function createWorkerEnv() {
  const workerEnv = new WorkerEnv({
    systemBase: {
      HOME: '/home/testuser',
      PATH: '/usr/bin:/usr/local/bin',
      LC_ALL: 'C.UTF-8',
      NODE_ENV: 'test',
    },
    workerConfig: {
      authToken: 'secret-auth-token',
      trpcUrl: 'https://trpc.internal.example.com',
      previewProxyBaseUrl: 'https://preview.roomote.run',
      previewProxySubdomainSuffix: 'preview.roomote.run',
      roomoteAppUrl: 'https://app.roomote.example',
      appEnv: 'development',
    },
  });

  workerEnv.addServiceEnv({
    DATABASE_URL: 'postgres://localhost/test',
  });
  workerEnv.setRuntimeEnv({
    GH_TOKEN: 'gh-token',
    LEGACY_VALUE: 'old-value',
  });
  workerEnv.addUserEnv({
    NEXT_PUBLIC_API_BASE: 'https://workspace.example.test',
  });

  return workerEnv;
}

function createCaller(workerEnv?: WorkerEnv, runId = 1) {
  const commandEnv = {
    HOME: '/home/testuser',
    PATH: '/usr/bin:/usr/local/bin',
    LC_ALL: 'C.UTF-8',
    GH_TOKEN: 'gh-token',
    LEGACY_VALUE: 'old-value',
    ROOMOTE_TASK_ID: 'task-123',
    ROOMOTE_TASK_TYPE: 'standard',
    CLAUDE_APPEND_SYSTEM_PROMPT: 'follow the system instructions',
  };
  const setCommandEnv = vi.fn();
  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: true,
      getCommandEnv: () => ({ ...commandEnv }),
      setCommandEnv,
    },
    harnessManager: {
      getStatus: () => ({
        phase: 'running',
        taskStateEvent: null,
        sessionId: 'session-1',
        isConnected: true,
        sleepRemainingMs: 30_000,
      }),
    },
    auth: {
      runId,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId,
    workerEnv,
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), setCommandEnv };
}

describe('reloadDeploymentEnvVars procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCredentialWriteBarrierForTesting();
    mockGetResolvedRuntimeEnvVars.mockResolvedValue({
      OPENAI_API_KEY: 'new-openai-key',
      ANTHROPIC_API_KEY: 'new-anthropic-key',
    });
    mockFindFirstById.mockResolvedValue({
      id: 1,
      taskId: 'task-123',
      payload: { repo: 'owner/repo' },
    });
    mockInjectEnvVars.mockImplementation(
      (env: Record<string, string | undefined>) => {
        env.BASH_ENV = '/tmp/roomote/env.sh';
      },
    );
  });

  it('replaces user env vars while preserving service env and shell wiring', async () => {
    const workerEnv = createWorkerEnv();
    const { caller, setCommandEnv } = createCaller(workerEnv);

    const result = await caller.commands.reloadDeploymentEnvVars();

    expect(result.success).toBe(true);
    expect(result.names).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']),
    );
    expect(result.names).toHaveLength(2);
    expect(mockGetResolvedRuntimeEnvVars).toHaveBeenCalledWith({
      runId: 1,
    });
    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockInjectEnvVars).toHaveBeenCalledTimes(1);
    expect(mockInjectEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENAI_API_KEY: 'new-openai-key',
        ANTHROPIC_API_KEY: 'new-anthropic-key',
      }),
      { id: 1, taskId: 'task-123', payload: { repo: 'owner/repo' } },
      expect.objectContaining({
        previewProxyBaseUrl: 'https://preview.roomote.run',
        previewProxySubdomainSuffix: 'preview.roomote.run',
        syncSourceControlTokenFiles: false,
      }),
    );

    const reloadedEnv = workerEnv.buildUserFacingEnv();

    expect(reloadedEnv.DATABASE_URL).toBe('postgres://localhost/test');
    expect(reloadedEnv.OPENAI_API_KEY).toBe('new-openai-key');
    expect(reloadedEnv.ANTHROPIC_API_KEY).toBe('new-anthropic-key');
    expect(reloadedEnv.GH_TOKEN).toBeUndefined();
    expect(reloadedEnv.NEXT_PUBLIC_API_BASE).toBe(
      'https://workspace.example.test',
    );
    expect(reloadedEnv.BASH_ENV).toBe('/tmp/roomote/env.sh');
    expect(reloadedEnv.LEGACY_VALUE).toBeUndefined();
    expect(setCommandEnv).toHaveBeenCalledWith({
      HOME: '/home/testuser',
      PATH: '/usr/bin:/usr/local/bin',
      LC_ALL: 'C.UTF-8',
      OPENAI_API_KEY: 'new-openai-key',
      ANTHROPIC_API_KEY: 'new-anthropic-key',
      BASH_ENV: '/tmp/roomote/env.sh',
      ROOMOTE_TASK_ID: 'task-123',
      ROOMOTE_TASK_TYPE: 'standard',
      CLAUDE_APPEND_SYSTEM_PROMPT: 'follow the system instructions',
    });
  });

  it('keeps inherited model transport values out of environment shell files on reload', async () => {
    mockGetResolvedRuntimeEnvVars.mockResolvedValue({
      R_MODEL: 'openai/outer-model',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
    });
    mockFindFirstById.mockResolvedValue({
      id: 1,
      taskId: 'task-123',
      payload: { environmentId: 'environment-1' },
    });
    const workerEnv = createWorkerEnv();
    workerEnv.addUserEnv({ R_VISION_MODEL: 'openai/nested-vision-model' });
    const { caller } = createCaller(workerEnv);

    await caller.commands.reloadDeploymentEnvVars();

    expect(mockInjectEnvVars).toHaveBeenCalledWith(
      expect.objectContaining({ R_MODEL: 'openai/outer-model' }),
      expect.objectContaining({ payload: { environmentId: 'environment-1' } }),
      expect.objectContaining({
        omitInheritedModelRuntimeEnvFromShell: true,
        explicitShellEnvVars: {
          NEXT_PUBLIC_API_BASE: 'https://workspace.example.test',
          R_VISION_MODEL: 'openai/nested-vision-model',
        },
      }),
    );
    expect(workerEnv.getRuntimeEnv()).toMatchObject({
      R_MODEL: 'openai/outer-model',
      R_SMALL_MODEL_REASONING_EFFORT: 'low',
    });
  });

  it('fails when the worker env is unavailable', async () => {
    const { caller } = createCaller(undefined);

    await expect(
      caller.commands.reloadDeploymentEnvVars(),
    ).rejects.toMatchObject({
      message: 'Worker environment is not available for live reload',
    });
  });

  it('rejects without writing env files once the credential write barrier is engaged', async () => {
    await engageCredentialWriteBarrier();

    const { caller } = createCaller(createWorkerEnv());

    await expect(
      caller.commands.reloadDeploymentEnvVars(),
    ).rejects.toMatchObject({
      message:
        'Environment reload is unavailable while the sandbox prepares for a snapshot',
    });
    expect(mockInjectEnvVars).not.toHaveBeenCalled();
  });
});
