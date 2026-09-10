import { TASK_MODEL_ROLE_DESCRIPTORS, TaskPayloadKind } from '@roomote/types';

import type { StartupLogger } from '../../logging';

const {
  mockSetupSystem,
  mockInstallMise,
  mockInstallBubblewrap,
  mockEnsurePython3,
  mockInstallPython,
  mockInstallAgentBrowser,
  mockInstallMediaBinaries,
  mockInstallAgentClis,
  mockInstallNodePty,
  mockInstallEmojiFont,
  mockInitializeWorkspaceRepositories,
  mockInitializeDockerProjects,
  mockInitializeWorkspaceServices,
  mockInitializeSystemWorkspaceServices,
  mockInitializeEnvironmentWorkspaceServices,
  mockInstallOrganizationEnvironmentSkills,
  mockExecuteOrganizationEnvironmentRepositoryCommands,
  mockSetupOrganizationEnvironment,
  mockEnvironmentSetupStatusWriter,
  mockTimedStep,
  mockGetRuntimeEnv,
  mockSetRuntimeEnv,
  mockSetUserEnv,
} = vi.hoisted(() => {
  const mockGetRuntimeEnv = vi.fn(() => ({}));
  const mockSetRuntimeEnv = vi.fn();
  const mockSetUserEnv = vi.fn();

  return {
    mockSetupSystem: vi.fn(),
    mockInstallMise: vi.fn(),
    mockInstallBubblewrap: vi.fn(),
    mockEnsurePython3: vi.fn(),
    mockInstallPython: vi.fn(),
    mockInstallAgentBrowser: vi.fn(),
    mockInstallMediaBinaries: vi.fn(),
    mockInstallAgentClis: vi.fn(),
    mockInstallNodePty: vi.fn(),
    mockInstallEmojiFont: vi.fn(),
    mockInitializeWorkspaceRepositories: vi.fn(),
    mockInitializeDockerProjects: vi.fn(),
    mockInitializeWorkspaceServices: vi.fn(),
    mockInitializeSystemWorkspaceServices: vi.fn(),
    mockInitializeEnvironmentWorkspaceServices: vi.fn(),
    mockInstallOrganizationEnvironmentSkills: vi.fn(),
    mockExecuteOrganizationEnvironmentRepositoryCommands: vi.fn(),
    mockSetupOrganizationEnvironment: vi.fn(),
    mockEnvironmentSetupStatusWriter: vi.fn(function () {
      return {
        initialize: vi.fn(),
        addWarnings: vi.fn(),
        markCommandRunning: vi.fn(),
        markCommandResult: vi.fn(),
        finalize: vi.fn(),
      };
    }),
    mockTimedStep: vi.fn(
      async <T>(
        _logger: unknown,
        _name: string,
        run: () => Promise<T> | T,
      ): Promise<T> => run(),
    ),
    mockGetRuntimeEnv,
    mockSetRuntimeEnv,
    mockSetUserEnv,
  };
});

vi.mock('../setup/system', () => ({
  setupSystem: mockSetupSystem,
}));

vi.mock('../setup/mise', () => ({
  installMise: mockInstallMise,
}));

vi.mock('../setup/legacy-runtime-tools', () => ({
  installBubblewrap: mockInstallBubblewrap,
  ensurePython3: mockEnsurePython3,
  installPython: mockInstallPython,
  installAgentBrowser: mockInstallAgentBrowser,
  installMediaBinaries: mockInstallMediaBinaries,
}));

vi.mock('../setup/agent-clis', () => ({
  installAgentClis: mockInstallAgentClis,
}));

vi.mock('../setup/node-pty', () => ({
  installNodePty: mockInstallNodePty,
}));

vi.mock('../setup/emoji-fonts', () => ({
  installEmojiFont: mockInstallEmojiFont,
}));

vi.mock('../setup/logging', () => ({
  timedStep: mockTimedStep,
  formatDurationMs: () => '1ms',
}));

vi.mock('../setup/workspace', () => ({
  initializeRepositories: mockInitializeWorkspaceRepositories,
  initializeDockerProjects: mockInitializeDockerProjects,
  initializeAllServices: mockInitializeWorkspaceServices,
  initializeSystemServices: mockInitializeSystemWorkspaceServices,
  initializeEnvironmentServices: mockInitializeEnvironmentWorkspaceServices,
  installOrganizationEnvironmentSkills:
    mockInstallOrganizationEnvironmentSkills,
  executeOrganizationEnvironmentRepositoryCommands:
    mockExecuteOrganizationEnvironmentRepositoryCommands,
  setupOrganizationEnvironment: mockSetupOrganizationEnvironment,
  EnvironmentSetupStatusWriter: mockEnvironmentSetupStatusWriter,
}));

import { setup } from '../setup';
import type { WorkerEnv } from '../../env';

const logger = {
  userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as StartupLogger;

const mockWorkerEnv = {
  buildUserFacingEnv: vi.fn(() => ({ BASE: 'base' })),
  sandboxOpenRouterApiKey: 'sandbox-openrouter-key',
  getRuntimeEnv: mockGetRuntimeEnv,
  refreshSystemEnv: vi.fn(),
  setRuntimeEnv: mockSetRuntimeEnv,
  setUserEnv: mockSetUserEnv,
} as unknown as WorkerEnv;

const workspaceOptions = {
  workspace: {
    type: 'repository' as const,
    repository: 'owner/repo',
    branch: 'main',
  },
  envVars: { FOO: 'bar' },
  taskRunType: TaskPayloadKind.StandardTask,
};

const environmentWorkspaceOptions = {
  workspace: {
    type: 'environment' as const,
    environmentId: 'env_123',
    environmentConfig: {
      name: 'Test Environment',
      repositories: [{ repository: 'owner/repo' }],
    },
  },
  envVars: {
    FOO: 'bar',
    R_TRIAL_OPENROUTER_API_KEY: 'trial-key',
    R_MODEL: 'roomote/openai/broken-model',
    R_SMALL_MODEL: 'roomote/openai/broken-small-model',
    R_MODEL_REASONING_EFFORT: 'high',
    R_MODEL_ENV_KEYS: 'R_TRIAL_OPENROUTER_API_KEY',
    R_INFERENCE_GATEWAY_KEYS: 'R_TRIAL_OPENROUTER_API_KEY',
  },
  taskRunType: TaskPayloadKind.StandardTask,
};

describe('setup mode behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializeWorkspaceRepositories.mockResolvedValue({
      workspacePath: '/tmp/workspace',
    });
    mockInitializeDockerProjects.mockResolvedValue(undefined);
    mockInitializeWorkspaceServices.mockResolvedValue({
      services: [],
      env: {},
    });
    mockInitializeSystemWorkspaceServices.mockResolvedValue({
      services: [],
      env: {},
    });
    mockInitializeEnvironmentWorkspaceServices.mockResolvedValue({
      services: [],
      env: {},
    });
    mockInstallOrganizationEnvironmentSkills.mockResolvedValue(undefined);
    mockExecuteOrganizationEnvironmentRepositoryCommands.mockResolvedValue([]);
  });

  it('runs full setup in full mode', async () => {
    await setup({
      mode: 'full',
      workspace: workspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockInstallPython).toHaveBeenCalledTimes(1);
    expect(mockEnsurePython3).toHaveBeenCalledTimes(1);
    expect(mockInstallBubblewrap).toHaveBeenCalledTimes(1);
    expect(mockInstallAgentBrowser).toHaveBeenCalledTimes(1);
    expect(mockInstallMediaBinaries).toHaveBeenCalledTimes(1);
    expect(mockInstallMise).toHaveBeenCalledTimes(1);
    expect(mockInstallAgentClis).toHaveBeenCalledTimes(1);
    expect(mockInstallNodePty).toHaveBeenCalledTimes(1);
    expect(mockInstallEmojiFont).toHaveBeenCalledTimes(1);
    const installBubblewrapOrder =
      mockInstallBubblewrap.mock.invocationCallOrder[0];
    const ensurePython3Order = mockEnsurePython3.mock.invocationCallOrder[0];
    const installPythonOrder = mockInstallPython.mock.invocationCallOrder[0];
    const installMiseOrder = mockInstallMise.mock.invocationCallOrder[0];
    const installAgentClisOrder =
      mockInstallAgentClis.mock.invocationCallOrder[0];
    const installNodePtyOrder = mockInstallNodePty.mock.invocationCallOrder[0];
    const initializeRepositoriesOrder =
      mockInitializeWorkspaceRepositories.mock.invocationCallOrder[0];
    const setupOrganizationEnvironmentOrder =
      mockSetupOrganizationEnvironment.mock.invocationCallOrder[0];
    expect(installBubblewrapOrder).toBeDefined();
    expect(ensurePython3Order).toBeDefined();
    expect(installPythonOrder).toBeDefined();
    expect(installMiseOrder).toBeDefined();
    expect(installAgentClisOrder).toBeDefined();
    expect(installNodePtyOrder).toBeDefined();
    expect(initializeRepositoriesOrder).toBeDefined();
    expect(setupOrganizationEnvironmentOrder).toBeUndefined();
    expect(installBubblewrapOrder ?? 0).toBeLessThan(ensurePython3Order ?? 0);
    expect(ensurePython3Order ?? 0).toBeLessThan(installMiseOrder ?? 0);
    expect(installAgentClisOrder ?? 0).toBeLessThan(installNodePtyOrder ?? 0);
    expect(installNodePtyOrder ?? 0).toBeLessThan(
      initializeRepositoriesOrder ?? 0,
    );
    expect(installMiseOrder ?? 0).toBeLessThan(
      initializeRepositoriesOrder ?? 0,
    );
    expect(initializeRepositoriesOrder ?? 0).toBeLessThan(
      installPythonOrder ?? 0,
    );
    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledTimes(1);
    expect(mockInitializeDockerProjects).toHaveBeenCalledTimes(1);
    expect(mockInitializeDockerProjects).toHaveBeenCalledWith(
      logger,
      expect.objectContaining({
        cleanupLegacyPaths: false,
        envVars: { BASE: 'base', FOO: 'bar' },
      }),
      { workspacePath: '/tmp/workspace' },
    );
    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledWith(logger, {
      ...workspaceOptions,
      cleanupLegacyPaths: false,
      envVars: { BASE: 'base', FOO: 'bar' },
    });
    expect(mockInitializeWorkspaceServices).toHaveBeenCalledTimes(1);
    expect(mockInitializeSystemWorkspaceServices).not.toHaveBeenCalled();
    expect(mockInitializeEnvironmentWorkspaceServices).not.toHaveBeenCalled();
    expect(mockSetupOrganizationEnvironment).not.toHaveBeenCalled();
    expect(mockSetUserEnv).toHaveBeenCalledWith({
      BASE: 'base',
      FOO: 'bar',
    });
  });

  it('only prepares repositories in directDispatch mode', async () => {
    await setup({
      mode: 'directDispatch',
      workspace: workspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockSetupSystem).toHaveBeenCalledTimes(1);
    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledTimes(1);
    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledWith(logger, {
      ...workspaceOptions,
      cleanupLegacyPaths: false,
      envVars: { BASE: 'base', FOO: 'bar' },
    });
    expect(mockInitializeEnvironmentWorkspaceServices).not.toHaveBeenCalled();
    expect(mockInstallPython).not.toHaveBeenCalled();
    expect(mockInstallBubblewrap).not.toHaveBeenCalled();
    expect(mockInstallAgentBrowser).not.toHaveBeenCalled();
    expect(mockInstallMediaBinaries).not.toHaveBeenCalled();
    expect(mockInstallMise).not.toHaveBeenCalled();
    expect(mockInstallAgentClis).not.toHaveBeenCalled();
    expect(mockInstallNodePty).not.toHaveBeenCalled();
    expect(mockInstallEmojiFont).not.toHaveBeenCalled();
    expect(mockInitializeWorkspaceServices).not.toHaveBeenCalled();
    expect(mockInitializeDockerProjects).not.toHaveBeenCalled();
    expect(mockInitializeSystemWorkspaceServices).not.toHaveBeenCalled();
    expect(mockSetupOrganizationEnvironment).not.toHaveBeenCalled();
    expect(mockSetUserEnv).toHaveBeenCalledWith({
      BASE: 'base',
      FOO: 'bar',
    });
  });

  it('installs the python shim after repository initialization but before environment commands', async () => {
    await setup({
      mode: 'full',
      workspace: environmentWorkspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
    });

    const initializeRepositoriesOrder =
      mockInitializeWorkspaceRepositories.mock.invocationCallOrder[0];
    const installPythonOrder = mockInstallPython.mock.invocationCallOrder[0];
    const initializeDockerProjectsOrder =
      mockInitializeDockerProjects.mock.invocationCallOrder[0];
    const setupOrganizationEnvironmentOrder =
      mockSetupOrganizationEnvironment.mock.invocationCallOrder[0];

    expect(initializeRepositoriesOrder).toBeDefined();
    expect(installPythonOrder).toBeDefined();
    expect(initializeDockerProjectsOrder).toBeDefined();
    expect(setupOrganizationEnvironmentOrder).toBeDefined();
    expect(initializeRepositoriesOrder ?? 0).toBeLessThan(
      initializeDockerProjectsOrder ?? 0,
    );
    expect(initializeDockerProjectsOrder ?? 0).toBeLessThan(
      installPythonOrder ?? 0,
    );
    expect(installPythonOrder ?? 0).toBeLessThan(
      setupOrganizationEnvironmentOrder ?? 0,
    );
  });

  it('runs environment repository commands best-effort for standard environment setup', async () => {
    const repoPaths = { 'owner/repo': '/tmp/workspace/owner/repo' };
    const inheritedRoleEnvVars = Object.fromEntries(
      Object.values(TASK_MODEL_ROLE_DESCRIPTORS).flatMap((descriptor) => [
        [descriptor.modelEnvVar, 'openai/outer-model'],
        [descriptor.reasoningEnvVar, 'high'],
        [`ROOMOTE_${descriptor.modelEnvVar.slice(2)}`, 'openai/outer-model'],
        [`ROOMOTE_${descriptor.reasoningEnvVar.slice(2)}`, 'high'],
      ]),
    );
    mockInitializeWorkspaceRepositories.mockResolvedValueOnce({
      workspacePath: '/tmp/workspace',
      environment: { repoPaths },
    });

    await setup({
      mode: 'full',
      workspace: {
        ...environmentWorkspaceOptions,
        userEnvVars: {
          FOO: 'bar',
          ...inheritedRoleEnvVars,
        },
      },
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockSetupOrganizationEnvironment).toHaveBeenCalledWith(logger, {
      environment: environmentWorkspaceOptions.workspace,
      envVars: {
        BASE: 'base',
        FOO: 'bar',
        OPENROUTER_API_KEY: 'sandbox-openrouter-key',
      },
      userEnvVars: { FOO: 'bar' },
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        environment: { repoPaths },
      },
      continueRepositoryCommandFailures: true,
      setupStatusWriter: expect.anything(),
      recordPhase: undefined,
    });
    expect(
      mockEnvironmentSetupStatusWriter.mock.results[0]?.value.initialize,
    ).toHaveBeenCalledWith(
      environmentWorkspaceOptions.workspace.environmentConfig.repositories,
      repoPaths,
    );
  });

  it('preserves explicit model overrides for repository workspaces', async () => {
    await setup({
      mode: 'directDispatch',
      workspace: {
        ...workspaceOptions,
        userEnvVars: {
          R_MODEL: 'openai/explicit-model',
          R_MODEL_REASONING_EFFORT: 'high',
        },
      },
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledWith(logger, {
      ...workspaceOptions,
      cleanupLegacyPaths: false,
      envVars: { BASE: 'base', FOO: 'bar' },
      userEnvVars: {
        R_MODEL: 'openai/explicit-model',
        R_MODEL_REASONING_EFFORT: 'high',
      },
    });
  });

  it('maps a stored sandbox OpenRouter key without inheriting outer model configuration', async () => {
    const storedKeyWorkerEnv = {
      ...mockWorkerEnv,
      sandboxOpenRouterApiKey: undefined,
    } as unknown as WorkerEnv;

    await setup({
      mode: 'directDispatch',
      workspace: {
        ...environmentWorkspaceOptions,
        envVars: {
          ...environmentWorkspaceOptions.envVars,
          R_CODE_REVIEW_MODEL: 'roomote/openai/broken-review-model',
          ROOMOTE_PLANNING_MODEL: 'roomote/openai/broken-planning-model',
        },
      },
      logger,
      workerEnv: storedKeyWorkerEnv,
      sandboxOpenRouterApiKey: 'stored-sandbox-openrouter-key',
    });

    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledWith(
      logger,
      expect.objectContaining({
        envVars: {
          BASE: 'base',
          FOO: 'bar',
          OPENROUTER_API_KEY: 'stored-sandbox-openrouter-key',
        },
      }),
    );
    expect(mockSetUserEnv).toHaveBeenCalledWith({
      BASE: 'base',
      FOO: 'bar',
      OPENROUTER_API_KEY: 'stored-sandbox-openrouter-key',
    });
  });

  it('removes the sandbox OpenRouter source name from the worker runtime env', async () => {
    mockGetRuntimeEnv.mockReturnValueOnce({
      SANDBOX_OPENROUTER_API_KEY: 'sandbox-openrouter-key',
      R_MODEL: 'roomote/openai/outer-model',
    });

    await setup({
      mode: 'directDispatch',
      workspace: environmentWorkspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockSetRuntimeEnv).toHaveBeenCalledWith({
      R_MODEL: 'roomote/openai/outer-model',
    });
  });

  it('retains explicit environment values that initially equal runtime values', async () => {
    mockGetRuntimeEnv.mockReturnValueOnce({
      R_VISION_MODEL: 'openai/shared-model',
    });
    mockInitializeWorkspaceRepositories.mockImplementationOnce(
      async (_logger, options) => {
        options.envVars.R_VISION_MODEL = 'openai/shared-model';
        return { workspacePath: '/tmp/workspace' };
      },
    );

    await setup({
      mode: 'directDispatch',
      workspace: {
        ...environmentWorkspaceOptions,
        workspace: {
          ...environmentWorkspaceOptions.workspace,
          environmentConfig: {
            ...environmentWorkspaceOptions.workspace.environmentConfig,
            env: { R_VISION_MODEL: 'openai/shared-model' },
          },
        },
        envVars: { R_VISION_MODEL: 'openai/shared-model' },
      },
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockSetUserEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        R_VISION_MODEL: 'openai/shared-model',
      }),
    );
  });

  it('keeps environment repository commands fatal for snapshot creation setup', async () => {
    await setup({
      mode: 'full',
      workspace: {
        ...environmentWorkspaceOptions,
        taskRunType: TaskPayloadKind.SnapshotEnvironment,
      },
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(mockInitializeWorkspaceRepositories).toHaveBeenCalledWith(logger, {
      ...environmentWorkspaceOptions,
      cleanupLegacyPaths: true,
      taskRunType: TaskPayloadKind.SnapshotEnvironment,
      envVars: {
        BASE: 'base',
        FOO: 'bar',
        OPENROUTER_API_KEY: 'sandbox-openrouter-key',
      },
    });
    expect(mockSetupOrganizationEnvironment).toHaveBeenCalledWith(logger, {
      environment: environmentWorkspaceOptions.workspace,
      envVars: {
        BASE: 'base',
        FOO: 'bar',
        OPENROUTER_API_KEY: 'sandbox-openrouter-key',
      },
      userEnvVars: undefined,
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
      },
      continueRepositoryCommandFailures: false,
      setupStatusWriter: expect.anything(),
      recordPhase: undefined,
    });
  });

  it('can continue after minimal environment setup while Docker projects and repository commands run in the background', async () => {
    const deferredBackgroundWarnings = [
      {
        message:
          'Optional environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
      },
    ];
    let releaseBackgroundSetup: (() => void) | undefined;
    let releaseDockerProjects: (() => void) | undefined;

    mockInitializeDockerProjects.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseDockerProjects = resolve;
        }),
    );

    mockExecuteOrganizationEnvironmentRepositoryCommands.mockImplementationOnce(
      async () => {
        await new Promise<void>((resolve) => {
          releaseBackgroundSetup = resolve;
        });
        return deferredBackgroundWarnings;
      },
    );

    const result = await setup({
      mode: 'full',
      workspace: environmentWorkspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
      backgroundEnvironmentSetup: true,
    });

    expect(mockSetupOrganizationEnvironment).not.toHaveBeenCalled();
    expect(mockInitializeDockerProjects).toHaveBeenCalledTimes(1);
    expect(mockInstallOrganizationEnvironmentSkills).toHaveBeenCalledWith(
      logger,
      expect.objectContaining({
        environment: environmentWorkspaceOptions.workspace,
      }),
    );
    expect(
      mockExecuteOrganizationEnvironmentRepositoryCommands,
    ).not.toHaveBeenCalled();
    expect(result.preparedWorkspace?.environmentSetupWarnings).toEqual([
      {
        message:
          'Environment setup is still running in the background. Docker projects may still be building or waiting for health checks, and repository setup commands may still be installing dependencies or preparing services.',
      },
    ]);
    expect(result.backgroundEnvironmentSetup).toBeDefined();

    releaseDockerProjects?.();
    await vi.waitFor(() => {
      expect(
        mockExecuteOrganizationEnvironmentRepositoryCommands,
      ).toHaveBeenCalledWith(
        logger,
        expect.objectContaining({
          environment: environmentWorkspaceOptions.workspace,
          continueRepositoryCommandFailures: true,
        }),
      );
    });
    releaseBackgroundSetup?.();
    await expect(result.backgroundEnvironmentSetup).resolves.toEqual(
      deferredBackgroundWarnings,
    );
    expect(result.preparedWorkspace?.environmentSetupWarnings).toEqual([
      {
        message:
          'Environment setup is still running in the background. Docker projects may still be building or waiting for health checks, and repository setup commands may still be installing dependencies or preparing services.',
      },
      {
        message:
          'Optional environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
      },
    ]);
  });

  it('reports a background Docker project failure without failing task startup', async () => {
    mockInitializeDockerProjects.mockRejectedValueOnce(
      new Error('backend failed its health check'),
    );

    const result = await setup({
      mode: 'full',
      workspace: environmentWorkspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
      backgroundEnvironmentSetup: true,
    });

    await expect(result.backgroundEnvironmentSetup).resolves.toEqual([
      {
        message:
          'Background Docker project setup failed: backend failed its health check',
      },
    ]);
    expect(result.preparedWorkspace?.environmentSetupWarnings).toContainEqual({
      message:
        'Background Docker project setup failed: backend failed its health check',
    });
  });

  it('keeps Docker project failures blocking when background setup is disabled', async () => {
    mockInitializeDockerProjects.mockRejectedValueOnce(
      new Error('backend failed its health check'),
    );

    await expect(
      setup({
        mode: 'full',
        workspace: environmentWorkspaceOptions,
        logger,
        workerEnv: mockWorkerEnv,
      }),
    ).rejects.toThrow('backend failed its health check');
  });

  it('continues after environment service startup failures for standard tasks', async () => {
    mockInitializeWorkspaceServices.mockRejectedValueOnce(
      new Error('postgres failed to become healthy'),
    );

    const result = await setup({
      mode: 'full',
      workspace: environmentWorkspaceOptions,
      logger,
      workerEnv: mockWorkerEnv,
    });

    expect(result.preparedWorkspace?.environmentSetupWarnings).toEqual([
      {
        message:
          'Environment services failed to start: postgres failed to become healthy',
      },
    ]);
    expect(logger.userLog.warn).toHaveBeenCalledWith(
      'Environment services failed to start: postgres failed to become healthy Continuing without a fully configured environment.',
    );
  });

  it('keeps snapshot environment service startup failures fatal', async () => {
    mockInitializeWorkspaceServices.mockRejectedValueOnce(
      new Error('docker failed to start'),
    );

    await expect(
      setup({
        mode: 'full',
        workspace: {
          ...environmentWorkspaceOptions,
          taskRunType: TaskPayloadKind.SnapshotEnvironment,
        },
        logger,
        workerEnv: mockWorkerEnv,
      }),
    ).rejects.toThrow('docker failed to start');

    expect(logger.userLog.warn).not.toHaveBeenCalledWith(
      'Environment services failed to start: docker failed to start Continuing without a fully configured environment.',
    );
  });
});
