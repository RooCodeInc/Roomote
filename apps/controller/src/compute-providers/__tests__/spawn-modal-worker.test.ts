import type { TaskRun } from '@roomote/db/server';
import type { RunCommandInput } from '@roomote/compute-providers';
import { TaskPayloadKind } from '@roomote/types';

const mockCreateModalMachine = vi.fn();
const mockRunCommand = vi.fn();
const mockCleanupModalInstance = vi.fn();
const mockRecordMutation = vi.fn();
const mockCreateComputeProviderClient = vi.fn((_arg?: unknown) => ({
  capabilities: {
    supportsCommandOutputLookup: false,
  },
  runCommand: mockRunCommand,
}));
const mockCreateComputeProviderMutationEventRecorder = vi.fn(
  () => mockRecordMutation,
);
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn((_values: Record<string, unknown>) => ({
  where: mockUpdateWhere,
}));
const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
const mockSql = vi.fn(
  (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
);
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
    sql: mockSql,
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
          // The captured output is folded into the error message so the
          // failure is diagnosable from controller logs alone.
          error:
            'Detached "worker run" exited immediately with code 17; stderr: Unauthorized; stdout: booting worker',
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

  it('records that command output lookup is unsupported when Modal returns no detached command ID', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: null,
      commandId: undefined,
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
    ).resolves.toEqual({ machineId: 'modal-machine-123' });

    expect(mockRecordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'run_command',
        eventType: 'completed',
        instanceId: 'modal-machine-123',
        details: expect.objectContaining({
          detached: true,
          phase: 'launch_worker',
          commandId: null,
          commandOutputLookupSupported: false,
          exitCode: null,
        }),
      }),
    );
    expect(
      mockUpdateSet.mock.calls.some(([values]) =>
        Object.hasOwn(values, 'sandboxCmdId'),
      ),
    ).toBe(false);
  });

  it('retains timestamped stdout and stderr for Roomote-backed commands', async () => {
    mockRunCommand.mockImplementationOnce(async (input: RunCommandInput) => {
      input.onOutput?.({ stream: 'stdout', data: 'worker\0 ready\n' });
      input.onOutput?.({ stream: 'stderr', data: 'setup warning\n' });
      return { exitCode: null, commandId: 'exec-123' };
    });

    await expect(
      spawnModalWorker(
        mockTaskRun({
          vendor: 'roomote',
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          vendor: 'roomote',
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
        },
      ),
    ).resolves.toEqual({
      machineId: 'modal-machine-123',
      sandboxCmdId: 'exec-123',
    });

    const retainedOutput = mockSql.mock.calls
      .map((call) => call[2])
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('['),
      )
      .join('');
    expect(retainedOutput).toMatch(
      /\[\d{4}-\d{2}-\d{2}T.*Z\] \[command\] sandbox provisioning started\n/,
    );
    expect(retainedOutput).toMatch(
      /\[\d{4}-\d{2}-\d{2}T.*Z\] \[command\] worker run 123 started on modal-machine-123\n/,
    );
    expect(retainedOutput).toMatch(
      /\[\d{4}-\d{2}-\d{2}T.*Z\] \[stdout\] worker ready\n/,
    );
    expect(retainedOutput).toMatch(
      /\[\d{4}-\d{2}-\d{2}T.*Z\] \[stderr\] setup warning\n/,
    );
    expect(retainedOutput).toMatch(
      /\[\d{4}-\d{2}-\d{2}T.*Z\] \[command\] worker is running as command exec-123\n/,
    );
    expect(retainedOutput).not.toContain('\0');
  });

  it('retains Roomote sandbox provisioning failures before command startup', async () => {
    mockCreateModalMachine.mockRejectedValueOnce(
      new Error('capacity unavailable'),
    );

    await expect(
      spawnModalWorker(
        mockTaskRun({
          vendor: 'roomote',
          payloadKind: TaskPayloadKind.StandardTask,
          payload: { repo: 'test/repo', environmentId: 'env_1' },
        }),
        'auth_token',
        {
          vendor: 'roomote',
          deploymentSlug: 'roomote',
          modalTokenId: 'token-id',
          modalTokenSecret: 'token-secret',
          modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
          modalVmMemoryMiB: 8192,
          modalTimeoutMs: 60_000,
        },
      ),
    ).rejects.toThrow('capacity unavailable');

    const retainedOutput = mockSql.mock.calls
      .map((call) => call[2])
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.startsWith('['),
      )
      .join('');
    expect(retainedOutput).toContain(
      '[command] sandbox provisioning started\n',
    );
    expect(retainedOutput).toContain(
      '[command] sandbox provisioning failed: capacity unavailable\n',
    );
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('bounds retained Roomote output while preserving the newest text', async () => {
    mockRunCommand.mockImplementationOnce(async (input: RunCommandInput) => {
      input.onOutput?.({
        stream: 'stdout',
        data: `${'x'.repeat(300 * 1024)}LATEST_OUTPUT\n`,
      });
      return { exitCode: null, commandId: 'exec-large' };
    });

    await spawnModalWorker(
      mockTaskRun({
        vendor: 'roomote',
        payloadKind: TaskPayloadKind.StandardTask,
        payload: { repo: 'test/repo', environmentId: 'env_1' },
      }),
      'auth_token',
      {
        vendor: 'roomote',
        deploymentSlug: 'roomote',
        modalTokenId: 'token-id',
        modalTokenSecret: 'token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalVmMemoryMiB: 8192,
        modalTimeoutMs: 60_000,
      },
    );

    const stdoutEntry = mockSql.mock.calls
      .map((call) => call[2])
      .find(
        (value): value is string =>
          typeof value === 'string' && value.includes('[stdout]'),
      );
    expect(stdoutEntry).toBeDefined();
    expect(stdoutEntry!.length).toBeLessThanOrEqual(256 * 1024);
    expect(stdoutEntry).toContain('LATEST_OUTPUT\n');
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

  it('probes the sandbox for diagnostics when an immediate detached exit captured no output', async () => {
    mockRunCommand
      // Detached launch: dies instantly and Modal delivers no output.
      .mockResolvedValueOnce({ exitCode: 1, commandId: undefined })
      // Non-detached probe: reproduces the startup crash with real stderr.
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'Error: WORKER_API_URL is required\n',
      });

    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.SnapshotEnvironment,
          payload: { repo: '', environmentId: 'env_1' },
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
    ).rejects.toThrow(
      'Detached "worker snapshot" exited immediately with code 1; ' +
        'probe "worker --version" exited with code 1; ' +
        'probe stderr: Error: WORKER_API_URL is required',
    );

    expect(mockRunCommand).toHaveBeenCalledTimes(2);
    expect(mockRunCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        cmd: 'worker',
        args: ['--version'],
      }),
    );
  });

  it('skips the diagnostic probe when the immediate exit already captured output', async () => {
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
        },
      ),
    ).rejects.toThrow(
      'Detached "worker run" exited immediately with code 1; stderr: worker failed before claim',
    );

    // Only the detached launch itself — no probe.
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
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

    expect(onWorkerExit).toHaveBeenCalledWith({
      exitCode: 1,
      launchDiagnostics: 'stderr: worker failed before claim',
    });
    expect(mockCleanupModalInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'modal-machine-123',
        phase: 'spawn_worker',
      }),
    );
    expect(onWorkerRestart).toHaveBeenCalledOnce();
  });

  it('passes probe diagnostics to the exit classifier when a silent immediate exit is finalized as failed', async () => {
    const onWorkerExit = vi.fn().mockResolvedValue('failed');
    mockRunCommand
      // Detached launch: dies instantly with no output.
      .mockResolvedValueOnce({ exitCode: 1, commandId: undefined })
      // Non-detached probe reproduces the crash.
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'Error: WORKER_API_URL is required\n',
      });

    // The classifier owns finalization on 'failed', so the spawn itself
    // resolves instead of rethrowing.
    await expect(
      spawnModalWorker(
        mockTaskRun({
          payloadKind: TaskPayloadKind.SnapshotEnvironment,
          payload: { repo: '', environmentId: 'env_1' },
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
      ),
    ).resolves.toEqual({ machineId: 'modal-machine-123' });

    expect(onWorkerExit).toHaveBeenCalledWith({
      exitCode: 1,
      launchDiagnostics:
        'probe "worker --version" exited with code 1; ' +
        'probe stderr: Error: WORKER_API_URL is required',
    });
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
