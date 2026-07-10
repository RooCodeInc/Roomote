const {
  createHarnessLoggerMock,
  createComputeProviderUsageIntervalMock,
  createWorkerHeartbeatIntervalMock,
  createStartupLoggerMock,
  findFirstByIdMock,
  finalizeJobMock,
  handleJobErrorMock,
  injectEnvVarsMock,
  sdkCloudJobsRecordEventMock,
  sdkCloudJobsStampMilestoneMock,
  sdkCloudJobsUpdateMock,
  setupMock,
  workerEnvFromProcessEnvMock,
  writeBashrcMock,
} = vi.hoisted(() => ({
  createHarnessLoggerMock: vi.fn(),
  createComputeProviderUsageIntervalMock: vi.fn(() => ({
    stop: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
  createWorkerHeartbeatIntervalMock: vi.fn(() => ({ __interval: true })),
  createStartupLoggerMock: vi.fn(),
  findFirstByIdMock: vi.fn(),
  finalizeJobMock: vi.fn().mockResolvedValue(undefined),
  handleJobErrorMock: vi.fn().mockResolvedValue('failed'),
  injectEnvVarsMock: vi.fn(),
  sdkCloudJobsRecordEventMock: vi.fn().mockResolvedValue(undefined),
  sdkCloudJobsStampMilestoneMock: vi.fn().mockResolvedValue(undefined),
  sdkCloudJobsUpdateMock: vi.fn().mockResolvedValue(undefined),
  setupMock: vi.fn(),
  workerEnvFromProcessEnvMock: vi.fn(),
  writeBashrcMock: vi.fn(),
}));

const { captureWorkerExceptionMock } = vi.hoisted(() => ({
  captureWorkerExceptionMock: vi.fn(),
}));

const { resolveWorkerReleaseMetadataMock } = vi.hoisted(() => ({
  resolveWorkerReleaseMetadataMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    cloudJobs: {
      findFirstById: findFirstByIdMock,
      recordEvent: sdkCloudJobsRecordEventMock,
      stampMilestone: sdkCloudJobsStampMilestoneMock,
      update: sdkCloudJobsUpdateMock,
    },
  },
}));

vi.mock('../../env', () => ({
  WorkerEnv: {
    fromProcessEnv: workerEnvFromProcessEnvMock,
  },
}));

vi.mock('../../logging', () => ({
  HARNESS_LOG_FILE_NAME: 'test-harness.log',
  createHarnessLogger: createHarnessLoggerMock,
  createStartupLogger: createStartupLoggerMock,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: captureWorkerExceptionMock,
}));

vi.mock('../../monitoring/worker-release-metadata', () => ({
  resolveWorkerReleaseMetadata: resolveWorkerReleaseMetadataMock,
}));

vi.mock('../../run-task/polling/worker-heartbeat', () => ({
  createWorkerHeartbeatInterval: createWorkerHeartbeatIntervalMock,
}));

vi.mock('../../run-task/polling/compute-provider-usage', () => ({
  createComputeProviderUsageInterval: createComputeProviderUsageIntervalMock,
}));

vi.mock('../../callbacks', () => ({
  callbackMap: {
    standard: {},
    slack_app_mention: {},
  },
}));

vi.mock('../setup', () => ({
  setup: setupMock,
}));

vi.mock('./env-vars', () => ({
  injectEnvVars: injectEnvVarsMock,
  writeBashrc: writeBashrcMock,
}));

vi.mock('./service-context', () => ({
  buildServiceContextForPreviewProxy: vi.fn(() => ({
    serviceContext: 'preview-proxy',
  })),
}));

vi.mock('./job-lifecycle', () => ({
  finalizeJob: finalizeJobMock,
  handleJobError: handleJobErrorMock,
}));

import { CloudTaskStatus, TaskPayloadKind } from '@roomote/types';

import { WorkspaceRepositoryPreparationError } from '../setup/workspace/types';
import * as executeJobModule from './execute-job';

const { executeJob } = executeJobModule;

describe('executeJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    createStartupLoggerMock.mockReturnValue({
      debug: {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      setFilePath: vi.fn(),
    });

    createHarnessLoggerMock.mockReturnValue({
      cloudJobId: 42,
      filePath: '/tmp/test-harness.log',
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    workerEnvFromProcessEnvMock.mockReturnValue({
      authToken: 'job-token-123',
      trpcUrl: 'https://api-cte.ngrok.dev',
      appEnv: 'development',
      setRuntimeEnv: vi.fn(),
      buildUserFacingEnv: vi.fn(() => ({
        PATH: '/usr/bin',
      })),
    });
    resolveWorkerReleaseMetadataMock.mockReturnValue({
      workerReleaseTag: 'worker-v1.2.3',
      workerVersion: '1.2.3',
      workerCommit: 'abc123',
    });

    setupMock.mockResolvedValue({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
      },
    });
    findFirstByIdMock.mockResolvedValue(undefined);
  });

  it('keeps user env separate while routing model traffic through the proxy', async () => {
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {
        FOO: 'bar',
      },
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    const workspaceConfigFn = vi.fn().mockResolvedValue({
      env: {},
    });

    const result = await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn,
      runFn,
    });

    expect(result).toBe(true);
    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(createWorkerHeartbeatIntervalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        logger: expect.objectContaining({
          warn: expect.any(Function),
        }),
      }),
    );
    expect(createComputeProviderUsageIntervalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        computeProvider: 'docker',
        logger: expect.objectContaining({
          warn: expect.any(Function),
        }),
      }),
    );
    expect(createHarnessLoggerMock).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        logToConsole: false,
      }),
    );

    const setupArgs = setupMock.mock.calls[0]?.[0];
    expect(setupArgs.workspace.userEnvVars).toEqual({
      FOO: 'bar',
    });
    expect(setupArgs.workspace.envVars).toMatchObject({
      FOO: 'bar',
    });
    expect(typeof setupArgs.recordPhase).toBe('function');
    expect(sdkCloudJobsStampMilestoneMock).toHaveBeenCalledWith({
      cloudJobId: 42,
      field: 'setupCompletedAt',
    });
  });

  it('passes environment setup warnings through to the task runtime', async () => {
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    setupMock.mockResolvedValueOnce({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        environmentSetupWarnings: [
          {
            message:
              'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
          },
        ],
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: {
            repo: 'owner/repo',
          },
        },
        envVars: {},
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn,
    });

    expect(runFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceReadinessWarnings: [
          'Environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
        ],
      }),
    );
  });

  it('records outer workspace-config and setup phases before the harness starts', async () => {
    const startupLogger = {
      debug: {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      setFilePath: vi.fn(),
    };
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    createStartupLoggerMock.mockReturnValue(startupLogger);
    setupMock.mockResolvedValueOnce({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: {
            repo: 'owner/repo',
          },
        },
        envVars: {},
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({
        type: 'repository',
        env: {},
      }),
      runFn,
    });

    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'phase',
        message: 'resolveWorkspaceConfig',
        details: expect.objectContaining({
          phase: 'resolveWorkspaceConfig',
          outcome: 'ok',
          durationMs: expect.any(Number),
          setupMode: 'full',
        }),
      }),
    );
    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'phase',
        message: 'setupWorkspace',
        details: expect.objectContaining({
          phase: 'setupWorkspace',
          outcome: 'ok',
          durationMs: expect.any(Number),
          setupMode: 'full',
          workspaceType: 'repository',
        }),
      }),
    );
    expect(startupLogger.setFilePath).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test-harness.log'),
    );
  });

  it('starts eligible environment-backed tasks before repository commands finish', async () => {
    let releaseBackgroundSetup: (() => void) | undefined;
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    setupMock.mockResolvedValueOnce({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: false,
        environmentSetupWarnings: [
          {
            message:
              'Environment setup is still running in the background. Repository setup commands may still be installing dependencies or preparing services.',
          },
        ],
      },
      backgroundOrganizationEnvironmentSetup: new Promise((resolve) => {
        releaseBackgroundSetup = () =>
          resolve([
            {
              message:
                'Optional environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
            },
          ]);
      }),
    });

    const executionPromise = executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
          },
        },
        envVars: {},
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({
        type: 'environment',
        environmentId: 'env-1',
        environmentConfig: {
          name: 'Test Environment',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
      runFn,
    });

    await vi.waitFor(() => {
      expect(runFn).toHaveBeenCalledTimes(1);
    });
    expect(finalizeJobMock).not.toHaveBeenCalled();
    expect(setupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundOrganizationEnvironmentSetup: true,
      }),
    );

    releaseBackgroundSetup?.();
    await executionPromise;

    expect(finalizeJobMock).toHaveBeenCalledTimes(1);
    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'decision',
        details: expect.objectContaining({
          reason: 'background_environment_setup_warning',
          warnings: [
            'Optional environment command "pnpm install" failed for owner/repo: Command failed with exit code 1',
          ],
        }),
      }),
    );
  });

  it('keeps Slack setup onboarding on the blocking environment setup path', async () => {
    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.SlackAppMention,
          harness: 'opencode-server',
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
            webPath: '/setup',
            channel: 'C123',
            user: 'U123',
            text: 'start setup',
            ts: '1710000000.000100',
          },
        },
        envVars: {},
        setupOnboardingTask: true,
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({
        type: 'environment',
        environmentId: 'env-1',
        environmentConfig: {
          name: 'Test Environment',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
      runFn: vi.fn().mockResolvedValue({
        status: CloudTaskStatus.Idle,
      }),
    });

    expect(setupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundOrganizationEnvironmentSetup: false,
      }),
    );
  });

  it('keeps Slack setup onboarding on the blocking path when the typed flag is absent', async () => {
    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.SlackAppMention,
          harness: 'opencode-server',
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
            webPath: '/setup',
            channel: 'C123',
            user: 'U123',
            text: 'start setup',
            ts: '1710000000.000100',
          },
        },
        envVars: {},
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({
        type: 'environment',
        environmentId: 'env-1',
        environmentConfig: {
          name: 'Test Environment',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
      runFn: vi.fn().mockResolvedValue({
        status: CloudTaskStatus.Idle,
      }),
    });

    expect(setupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundOrganizationEnvironmentSetup: false,
      }),
    );
  });

  it('keeps resumed setup onboarding jobs on the blocking environment setup path', async () => {
    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.SnapshotResume,
          harness: 'opencode-server',
          sourceCloudJobId: 41,
          payload: {
            repo: 'owner/repo',
            environmentId: 'env-1',
            sourceCloudJobId: 41,
            sourceSnapshotId: 'snap-1',
          },
        },
        envVars: {},
        gitAuthor: {
          name: 'Chris',
          email: 'chris@example.com',
        },
        setupOnboardingTask: true,
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({
        type: 'environment',
        environmentId: 'env-1',
        environmentConfig: {
          name: 'Test Environment',
          repositories: [{ repository: 'owner/repo' }],
        },
      }),
      runFn: vi.fn().mockResolvedValue({
        status: CloudTaskStatus.Idle,
      }),
    });

    expect(setupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundOrganizationEnvironmentSetup: false,
      }),
    );
  });

  it('reads WorkerEnv after fetchFn returns so bootstrap failures keep launcher env tags intact', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {},
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({
        status: CloudTaskStatus.Idle,
      }),
    });

    const fetchInvocationOrder = fetchFn.mock.invocationCallOrder[0];
    const workerEnvInvocationOrder =
      workerEnvFromProcessEnvMock.mock.invocationCallOrder[0];

    expect(fetchInvocationOrder).toBeDefined();
    expect(workerEnvInvocationOrder).toBeDefined();
    expect(fetchInvocationOrder!).toBeLessThan(workerEnvInvocationOrder!);
  });

  it('emits a phase cloud_job_event with duration when setup invokes recordPhase', async () => {
    setupMock.mockImplementationOnce(
      async ({
        recordPhase,
      }: {
        recordPhase?: (input: {
          label: string;
          startedAtMs: number;
          endedAtMs: number;
          durationMs: number;
          outcome: 'ok' | 'error';
        }) => Promise<void>;
      }) => {
        await recordPhase?.({
          label: 'installMise',
          startedAtMs: 1000,
          endedAtMs: 1500,
          durationMs: 500,
          outcome: 'ok',
        });
        return { preparedWorkspace: { workspacePath: '/ws' } };
      },
    );

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: { repo: 'owner/repo' },
        },
        envVars: {},
        gitAuthor: { name: 'Chris', email: 'chris@example.com' },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({ status: CloudTaskStatus.Idle }),
    });

    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'phase',
        message: 'installMise',
        details: expect.objectContaining({
          phase: 'installMise',
          durationMs: 500,
          outcome: 'ok',
          setupMode: 'full',
        }),
      }),
    );
  });

  it('records a worker runtime event when all-repositories setup continues after skipping repositories', async () => {
    setupMock.mockResolvedValueOnce({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: true,
        repositoryPreparationOutcome: {
          mode: 'continued',
          workspaceType: 'all_repositories',
          totalRepositories: 3,
          preparedRepositoryCount: 2,
          repositories: [
            {
              repository: 'acme/docs',
              reason: 'Repository not found: acme/docs',
              diagnostics: 'git clone https://github.com/acme/docs.git',
            },
          ],
        },
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: { repo: 'owner/repo' },
        },
        envVars: {},
        gitAuthor: { name: 'Chris', email: 'chris@example.com' },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({ status: CloudTaskStatus.Idle }),
    });

    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'failed',
        message: expect.stringContaining(
          'Skipped 1 repository during all_repositories workspace setup and continued with 2 prepared repositories',
        ),
        details: expect.objectContaining({
          reason: 'workspace_repository_prepare_failed',
          failureMode: 'continued',
          workspaceType: 'all_repositories',
          cloudTaskType: TaskPayloadKind.StandardTask,
          totalRepositories: 3,
          preparedRepositoryCount: 2,
          failedRepositoryCount: 1,
          failedRepositories: [
            {
              repository: 'acme/docs',
              reason: 'Repository not found: acme/docs',
              diagnostics: 'git clone https://github.com/acme/docs.git',
            },
          ],
        }),
      }),
    );
  });

  it('records a worker runtime event when repository_set setup continues after skipping repositories', async () => {
    setupMock.mockResolvedValueOnce({
      preparedWorkspace: {
        workspacePath: '/tmp/workspace',
        usesSharedWorkspaceRoot: true,
        repositoryPreparationOutcome: {
          mode: 'continued',
          workspaceType: 'repository_set',
          totalRepositories: 2,
          preparedRepositoryCount: 1,
          repositories: [
            {
              repository: 'acme/docs',
              reason: 'Repository not found: acme/docs',
              diagnostics: 'git clone https://github.com/acme/docs.git',
            },
          ],
        },
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: { repo: 'owner/repo' },
        },
        envVars: {},
        gitAuthor: { name: 'Chris', email: 'chris@example.com' },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({ status: CloudTaskStatus.Idle }),
    });

    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'failed',
        message: expect.stringContaining(
          'Skipped 1 repository during repository_set workspace setup and continued with 1 prepared repository',
        ),
        details: expect.objectContaining({
          reason: 'workspace_repository_prepare_failed',
          failureMode: 'continued',
          workspaceType: 'repository_set',
          cloudTaskType: TaskPayloadKind.StandardTask,
          totalRepositories: 2,
          preparedRepositoryCount: 1,
          failedRepositoryCount: 1,
          failedRepositories: [
            {
              repository: 'acme/docs',
              reason: 'Repository not found: acme/docs',
              diagnostics: 'git clone https://github.com/acme/docs.git',
            },
          ],
        }),
      }),
    );
  });

  it('passes resolved worker runtime metadata into the fetch step', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {},
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({ status: CloudTaskStatus.Idle }),
    });

    expect(fetchFn).toHaveBeenCalledWith(42, {
      workerReleaseTag: 'worker-v1.2.3',
      workerVersion: '1.2.3',
      workerCommit: 'abc123',
    });
  });

  it('preserves operator-provided model provider env vars', async () => {
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {
        FOO: 'bar',
        OPENAI_API_KEY: 'sk-original-user-key',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    const workspaceConfigFn = vi.fn().mockResolvedValue({
      env: {},
    });

    const result = await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn,
      runFn,
    });

    expect(result).toBe(true);

    const setupArgs = setupMock.mock.calls[0]?.[0];
    expect(setupArgs.workspace.userEnvVars).toEqual({
      FOO: 'bar',
      OPENAI_API_KEY: 'sk-original-user-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
    expect(setupArgs.workspace.envVars).toMatchObject({
      FOO: 'bar',
      OPENAI_API_KEY: 'sk-original-user-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    });
  });

  it('starts the worker heartbeat before setup begins', async () => {
    const sequence: string[] = [];
    createWorkerHeartbeatIntervalMock.mockImplementationOnce(() => {
      sequence.push('heartbeat');
      return { __interval: true } as never;
    });
    createComputeProviderUsageIntervalMock.mockImplementationOnce(() => {
      sequence.push('compute-usage');
      return {
        stop: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      } as never;
    });
    setupMock.mockImplementationOnce(async () => {
      sequence.push('setup');
      return {
        preparedWorkspace: {
          workspacePath: '/tmp/workspace',
          usesSharedWorkspaceRoot: false,
        },
      };
    });

    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Idle,
    });

    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {
        FOO: 'bar',
      },
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    const workspaceConfigFn = vi.fn().mockResolvedValue({
      env: {},
    });

    await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn,
      runFn,
    });

    expect(sequence).toEqual(['heartbeat', 'compute-usage', 'setup']);
  });

  it('suppresses non-fatal finalization errors after external snapshot handoff has been claimed', async () => {
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Completed,
    });
    finalizeJobMock.mockRejectedValueOnce(new Error('fetch failed'));
    findFirstByIdMock.mockResolvedValue({
      id: 42,
      status: CloudTaskStatus.Idle,
      sleepRequestedAt: new Date('2026-04-10T10:53:57.130Z'),
      snapshotRequestedAt: new Date('2026-04-10T10:53:57.130Z'),
      snapshotCreatedAt: null,
      snapshotFailedAt: null,
    });

    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.SlackAppMention,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {
        FOO: 'bar',
      },
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    const workspaceConfigFn = vi.fn().mockResolvedValue({
      env: {},
    });

    const result = await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn,
      runFn,
    });

    expect(result).toBe(true);
    expect(findFirstByIdMock).toHaveBeenCalledWith(42);
    expect(handleJobErrorMock).not.toHaveBeenCalled();
    expect(captureWorkerExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      cloudJobId: 42,
      stage: 'executeJob.suppressedFinalizeError',
      latestStatus: CloudTaskStatus.Idle,
      snapshotRequestedAt: '2026-04-10T10:53:57.130Z',
      snapshotCreatedAt: null,
      snapshotFailedAt: null,
    });
  });

  it('still reports finalization errors when no durable post-run state exists yet', async () => {
    const runFn = vi.fn().mockResolvedValue({
      status: CloudTaskStatus.Completed,
    });
    finalizeJobMock.mockRejectedValueOnce(new Error('fetch failed'));
    findFirstByIdMock.mockResolvedValue({
      id: 42,
      status: CloudTaskStatus.Idle,
      sleepRequestedAt: null,
      snapshotRequestedAt: null,
      snapshotCreatedAt: null,
      snapshotFailedAt: null,
    });

    const fetchFn = vi.fn().mockResolvedValue({
      cloudJob: {
        id: 42,
        taskId: 'task-42',
        payloadKind: TaskPayloadKind.StandardTask,
        harness: 'opencode-server',
        payload: {
          repo: 'owner/repo',
        },
      },
      envVars: {
        FOO: 'bar',
      },
      gitAuthor: {
        name: 'Chris',
        email: 'chris@example.com',
      },
    });

    const workspaceConfigFn = vi.fn().mockResolvedValue({
      env: {},
    });

    const result = await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn,
      workspaceConfigFn,
      runFn,
    });

    expect(result).toBe(false);
    expect(handleJobErrorMock).toHaveBeenCalledWith({
      error: expect.any(Error),
      cloudJob: expect.objectContaining({ id: 42 }),
      logger: expect.any(Object),
      callbacks: {},
      context: {},
    });
  });

  it('records a structured worker runtime event before failing on fatal repository preparation errors', async () => {
    setupMock.mockRejectedValueOnce(
      new WorkspaceRepositoryPreparationError({
        mode: 'fatal',
        workspaceType: 'repository_set',
        totalRepositories: 2,
        preparedRepositoryCount: 1,
        repositories: [
          {
            repository: 'acme/docs',
            reason: 'Repository not found: acme/docs',
            diagnostics: 'stderr -> fatal: repository not found',
          },
        ],
      }),
    );

    const result = await executeJob({
      cloudJobId: 42,
      setupMode: 'full',
      fetchFn: vi.fn().mockResolvedValue({
        cloudJob: {
          id: 42,
          taskId: 'task-42',
          payloadKind: TaskPayloadKind.StandardTask,
          harness: 'opencode-server',
          payload: { repo: 'owner/repo' },
        },
        envVars: {},
        gitAuthor: { name: 'Chris', email: 'chris@example.com' },
      }),
      workspaceConfigFn: vi.fn().mockResolvedValue({ env: {} }),
      runFn: vi.fn().mockResolvedValue({ status: CloudTaskStatus.Idle }),
    });

    expect(result).toBe(false);
    expect(sdkCloudJobsRecordEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJobId: 42,
        source: 'worker_runtime',
        eventType: 'failed',
        message: expect.stringContaining(
          'Workspace setup failed while preparing repositories for the repository_set workspace after 1 successful repository',
        ),
        details: expect.objectContaining({
          reason: 'workspace_repository_prepare_failed',
          failureMode: 'fatal',
          workspaceType: 'repository_set',
          cloudTaskType: TaskPayloadKind.StandardTask,
          totalRepositories: 2,
          preparedRepositoryCount: 1,
          failedRepositoryCount: 1,
          failedRepositories: [
            {
              repository: 'acme/docs',
              reason: 'Repository not found: acme/docs',
              diagnostics: 'stderr -> fatal: repository not found',
            },
          ],
        }),
      }),
    );
    expect(handleJobErrorMock).toHaveBeenCalledWith({
      error: expect.any(WorkspaceRepositoryPreparationError),
      cloudJob: expect.objectContaining({ id: 42 }),
      logger: undefined,
      callbacks: {},
      context: {},
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
