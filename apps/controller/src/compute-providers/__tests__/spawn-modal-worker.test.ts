import type { TaskRun } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

const mockCreateModalMachine = vi.fn();
const mockRunCommand = vi.fn();
const mockCleanupModalInstance = vi.fn();
const mockRecordMutation = vi.fn();
const mockCreateComputeProviderClient = vi.fn((_arg?: unknown) => ({
  runCommand: mockRunCommand,
}));
const mockCreateComputeProviderMutationEventRecorder = vi.fn(
  () => mockRecordMutation,
);
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
const mockFindTask = vi.fn();
const mockUpdateTaskRunMachine = vi.fn();
const mockGetNamedPortsForTaskRun = vi.fn();
const mockShouldEnableAuthBypassForTaskRun = vi.fn(
  (..._args: unknown[]) => true,
);
const mockPrimeEnvironmentOidcForMachine = vi.fn();

function mockTaskRun(
  overrides: Partial<TaskRun> & Pick<TaskRun, 'payloadKind'>,
): TaskRun {
  return {
    id: 123,
    taskId: 'task_123',
    vendor: 'modal',
    sourceSnapshotId: null,
    payload: { repo: 'test/repo' },
    ...overrides,
  } as unknown as TaskRun;
}

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      ...actual.db,
      query: {
        ...actual.db.query,
        tasks: {
          findFirst: (...args: unknown[]) => mockFindTask(...args),
        },
      },
      update: () => mockDbUpdate(),
    },
    createComputeProviderMutationEventRecorder:
      mockCreateComputeProviderMutationEventRecorder,
  };
});

vi.mock('@roomote/compute-providers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@roomote/compute-providers')>();

  return {
    ...actual,
    createModalMachine: (...args: unknown[]) => mockCreateModalMachine(...args),
    createComputeProviderClient: (arg: unknown) =>
      mockCreateComputeProviderClient(arg),
    buildComputeProviderMutationDetails: vi.fn(
      (_context: unknown, details: Record<string, unknown> = {}) => details,
    ),
    buildModalWorkerEnv: vi.fn(() => ({ AUTH_TOKEN: 'auth_token' })),
    cleanupModalInstance: (...args: unknown[]) =>
      mockCleanupModalInstance(...args),
    resolveAuthBypassHeaderName: vi.fn(() => undefined),
    resolveAuthBypassValue: vi.fn(() => undefined),
  };
});

vi.mock('../../utils', () => ({
  getNamedPortsForTaskRun: (...args: unknown[]) =>
    mockGetNamedPortsForTaskRun(...args),
  shouldEnableAuthBypassForTaskRun: (...args: unknown[]) =>
    mockShouldEnableAuthBypassForTaskRun(...args),
  updateTaskRunMachine: (...args: unknown[]) =>
    mockUpdateTaskRunMachine(...args),
}));

vi.mock('../../sandbox-oidc', () => ({
  primeEnvironmentOidcForMachine: (...args: unknown[]) =>
    mockPrimeEnvironmentOidcForMachine(...args),
}));

const { spawnModalWorker } = await import('../spawn-modal-worker');

describe('spawnModalWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldEnableAuthBypassForTaskRun.mockReturnValue(true);
    mockFindTask.mockResolvedValue({ workflow: 'standard' });
    delete process.env.PREVIEW_PROXY_BASE_URL;

    mockCreateModalMachine.mockResolvedValue({
      machineId: 'modal-machine-123',
      domain: vi.fn().mockReturnValue('modal.example.com'),
      proxyPorts: {},
    });
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: 'cmd_123',
    });
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: undefined,
      environmentConfig: undefined,
    });
    mockPrimeEnvironmentOidcForMachine.mockResolvedValue(undefined);
  });

  it('forwards Modal regions into the compute client config', async () => {
    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_123' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'image-ref',
        modalRegions: ' us , us-west ',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'modal',
        config: expect.objectContaining({
          regions: ['us', 'us-west'],
          memoryMiB: 4096,
        }),
      }),
    );
  });

  it('uses a right-sized Modal VM sandbox for environments with Docker projects', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: undefined,
      environmentConfig: {
        docker_projects: [
          {
            name: 'app',
            type: 'compose',
            repository: 'test/repo',
            files: ['compose.yaml'],
          },
        ],
      },
    });

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_123' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'image-ref',
        modalVmMemoryMiB: 12_288,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'modal',
        config: expect.objectContaining({
          vmRuntime: true,
          cpu: 2,
          memoryMiB: 12_288,
        }),
      }),
    );
    expect(mockCreateModalMachine).toHaveBeenCalled();
    expect(mockFindTask).not.toHaveBeenCalled();
  });

  it('uses a Modal VM sandbox for setup onboarding before an environment config exists', async () => {
    mockFindTask.mockResolvedValue({ workflow: 'setup_onboarding' });

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'image-ref',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockFindTask).toHaveBeenCalledOnce();
    expect(mockCreateComputeProviderClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'modal',
        config: expect.objectContaining({
          vmRuntime: true,
          cpu: 2,
          memoryMiB: 8192,
        }),
      }),
    );
    expect(mockCreateModalMachine).toHaveBeenCalled();
  });

  it('primes environment OIDC before launching a fresh Modal worker when the environment defines OIDC targets', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: undefined,
      environmentConfig: {
        oidc: {
          aws: {
            role_arn: 'arn:aws:iam::123456789012:role/example',
            token_file: '/home/roomote/.roomote/oidc/aws/token',
          },
        },
      },
    });

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_123' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'image-ref',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockPrimeEnvironmentOidcForMachine).toHaveBeenCalledWith({
      environmentId: 'env_123',
      environmentConfig: {
        oidc: {
          aws: {
            role_arn: 'arn:aws:iam::123456789012:role/example',
            token_file: '/home/roomote/.roomote/oidc/aws/token',
          },
        },
      },
      computeProvider: 'modal',
      computeProviderId: 'modal-machine-123',
      runId: 123,
      taskId: 'task_123',
      context: 'Fresh Modal launch',
    });
  });

  it('records only a failed terminal run_command event when the detached worker exits immediately', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 17,
      commandId: 'cmd_failed',
      stderr: 'Unauthorized\n',
      stdout: 'booting worker\n',
    });

    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
        },
      ),
    ).rejects.toThrow('Detached "worker run" exited immediately with code 17');

    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'run_command',
        eventType: 'failed',
        instanceId: 'modal-machine-123',
        details: expect.objectContaining({
          command: 'worker',
          args: ['run', '123'],
          detached: true,
          phase: 'launch_worker',
          commandId: 'cmd_failed',
          exitCode: 17,
          stderr: 'Unauthorized',
          stdout: 'booting worker',
          error: 'Detached "worker run" exited immediately with code 17',
        }),
      }),
    );
    expect(mockRecordMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'run_command',
        eventType: 'completed',
        instanceId: 'modal-machine-123',
      }),
    );
    expect(mockCleanupModalInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        onMutation: expect.any(Function),
      }),
    );
  });

  it('cleans up when a detached worker exits with code zero during launch', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 0,
      commandId: undefined,
      stdout: 'worker stopped before claim\n',
    });

    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
        },
      ),
    ).rejects.toThrow('Detached "worker run" exited immediately with code 0');

    expect(mockCleanupModalInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        phase: 'spawn_worker',
      }),
    );
  });

  it('restarts when an immediate detached exit is claimed as the first bootstrap failure', async () => {
    const onWorkerExit = vi.fn().mockResolvedValue('restart');
    const onWorkerRestart = vi.fn();
    mockRunCommand.mockResolvedValue({
      exitCode: 1,
      commandId: undefined,
      stderr: 'worker failed before claim\n',
    });

    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
          onWorkerExit,
          onWorkerRestart,
        },
      ),
    ).resolves.toEqual({ machineId: 'modal-machine-123' });

    expect(onWorkerExit).toHaveBeenCalledWith({ exitCode: 1 });
    expect(mockCleanupModalInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        phase: 'spawn_worker',
      }),
    );
    expect(onWorkerRestart).toHaveBeenCalledOnce();
  });

  it('cleans up when a later detached exit is claimed as a bootstrap failure', async () => {
    const onWorkerExit = vi.fn().mockResolvedValue('restart');
    const onWorkerRestart = vi.fn();

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
        onWorkerExit,
        onWorkerRestart,
      },
    );

    const runCommandInput = mockRunCommand.mock.calls[0]?.[0] as {
      onExit?: (event: { exitCode: number }) => Promise<void>;
    };
    await runCommandInput.onExit?.({ exitCode: 1 });

    expect(onWorkerExit).toHaveBeenCalledWith({ exitCode: 1 });
    expect(mockCleanupModalInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        phase: 'worker_bootstrap_exit',
        onMutation: expect.any(Function),
      }),
    );
    expect(onWorkerRestart).toHaveBeenCalledOnce();
  });

  it('restarts after a claimed exit even when sandbox cleanup fails', async () => {
    const onWorkerExit = vi.fn().mockResolvedValue('restart');
    const onWorkerRestart = vi.fn();
    mockCleanupModalInstance.mockRejectedValueOnce(
      new Error('cleanup unavailable'),
    );

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
        onWorkerExit,
        onWorkerRestart,
      },
    );

    const runCommandInput = mockRunCommand.mock.calls[0]?.[0] as {
      onExit?: (event: { exitCode: number }) => Promise<void>;
    };
    await expect(runCommandInput.onExit?.({ exitCode: 1 })).rejects.toThrow(
      'cleanup unavailable',
    );

    expect(onWorkerRestart).toHaveBeenCalledOnce();
  });

  it('leaves the sandbox alone when a detached exit belongs to an advanced run', async () => {
    const onWorkerExit = vi.fn().mockResolvedValue('ignore');

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
        onWorkerExit,
      },
    );

    const runCommandInput = mockRunCommand.mock.calls[0]?.[0] as {
      onExit?: (event: { exitCode: number }) => Promise<void>;
    };
    await runCommandInput.onExit?.({ exitCode: 0 });

    expect(onWorkerExit).toHaveBeenCalledWith({ exitCode: 0 });
    expect(mockCleanupModalInstance).not.toHaveBeenCalled();
  });

  it('does not resolve or persist a bypass when no exposed surface needs one', async () => {
    mockShouldEnableAuthBypassForTaskRun.mockReturnValue(false);

    const {
      buildModalWorkerEnv,
      resolveAuthBypassHeaderName,
      resolveAuthBypassValue,
    } = await import('@roomote/compute-providers');
    vi.mocked(resolveAuthBypassValue).mockReturnValue('env-bypass-token');
    vi.mocked(resolveAuthBypassHeaderName).mockReturnValue('x-env-bypass');

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.StandardTask,
        taskId: 'innertask12345',
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(resolveAuthBypassValue).not.toHaveBeenCalled();
    expect(resolveAuthBypassHeaderName).not.toHaveBeenCalled();

    const extraEnv =
      vi.mocked(buildModalWorkerEnv).mock.calls[0]?.[0]?.extraEnv;
    expect(extraEnv).not.toHaveProperty('ROOMOTE_AUTH_BYPASS_VALUE');
    expect(extraEnv).not.toHaveProperty('ROOMOTE_AUTH_BYPASS_HEADER_NAME');
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        authBypassValue: undefined,
        authBypassHeaderName: undefined,
      }),
    );
  });

  it('uses task_snapshot launch mode for snapshot resume task runs', async () => {
    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: 'snap-task-123',
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockCreateModalMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'task_snapshot',
        sourceSnapshotId: 'snap-task-123',
      }),
    );
  });

  it('forces fresh launches for snapshot environment jobs even when an environment snapshot exists', async () => {
    mockGetNamedPortsForTaskRun.mockResolvedValue({
      namedPorts: [{ name: 'SANDBOX_SERVER', port: 7777 }],
      environmentSnapshotId: 'snap_env_123',
      environmentConfig: undefined,
    });

    await spawnModalWorker(
      mockTaskRun({
        payloadKind: TaskPayloadKind.SnapshotEnvironment,
        sourceSnapshotId: 'snap_job_ignored_123',
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    expect(mockCreateModalMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        launchMode: 'fresh',
      }),
    );

    const createMachineOptions = mockCreateModalMachine.mock.calls[0]?.[0];
    expect(createMachineOptions).not.toHaveProperty('sourceSnapshotId');
    expect(mockUpdateTaskRunMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSnapshotId: null,
      }),
    );
  });

  it('fails fast when a snapshot resume task run is missing sourceSnapshotId', async () => {
    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.SnapshotResume,
          sourceSnapshotId: null,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
        },
      ),
    ).rejects.toThrow('missing sourceSnapshotId');

    expect(mockCreateModalMachine).not.toHaveBeenCalled();
  });
});
