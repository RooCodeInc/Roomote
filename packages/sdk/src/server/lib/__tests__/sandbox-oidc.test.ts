const mockRunCommand = vi.fn();
const mockWriteFiles = vi.fn();
const mockGetInstanceStatus = vi.fn();
const mockRecordCloudJobEvent = vi.fn();
const mockFindManySandboxOidcTargets = vi.fn();
const mockEnvironmentFindFirst = vi.fn();
const mockCloudJobFindFirst = vi.fn();
const mockDbExecute = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({
  values: (...args: unknown[]) => {
    mockInsertValues(...args);
    return { onConflictDoUpdate: mockOnConflictDoUpdate };
  },
});
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockReturnValue({
  where: (...args: unknown[]) => mockDeleteWhere(...args),
});

vi.mock('@roomote/auth', () => ({
  SANDBOX_OIDC_REFRESH_BUFFER_MS: 60_000,
  SANDBOX_OIDC_TOKEN_TTL_MS: 300_000,
  createSandboxOidcToken: vi.fn(({ audience }) => `token:${audience}`),
  isSandboxOidcConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: vi.fn(() => ({
    writeFiles: (...args: unknown[]) => mockWriteFiles(...args),
    runCommand: (...args: unknown[]) => mockRunCommand(...args),
    getInstanceStatus: (...args: unknown[]) => mockGetInstanceStatus(...args),
  })),
}));

vi.mock('@roomote/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/types')>();

  return {
    ...actual,
    CloudTaskStatus: {
      Completed: 'completed',
      Failed: 'failed',
      Canceled: 'canceled',
    },
    getEnvironmentOidcTargets: vi.fn().mockReturnValue([]),
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ kind: 'and', args })),
  taskRuns: {},
  taskRunEvents: {},
  createRowMapper: vi.fn(() => (row: unknown) => row),
  db: {
    query: {
      sandboxOidcTargets: {
        findMany: (...args: unknown[]) =>
          mockFindManySandboxOidcTargets(...args),
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentFindFirst(...args),
      },
      taskRuns: {
        findFirst: (...args: unknown[]) => mockCloudJobFindFirst(...args),
      },
    },
    delete: (...args: unknown[]) => mockDelete(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
  environments: {},
  eq: vi.fn((...args: unknown[]) => ({ kind: 'eq', args })),
  inArray: vi.fn((...args: unknown[]) => ({ kind: 'inArray', args })),
  recordCloudJobEvent: (...args: unknown[]) => mockRecordCloudJobEvent(...args),
  sandboxOidcTargets: {
    awsRegion: 'awsRegion',
    awsRoleArn: 'awsRoleArn',
    audience: 'audience',
    runId: 'runId',
    computeProvider: 'computeProvider',
    computeProviderId: 'computeProviderId',
    environmentId: 'environmentId',
    expiresAt: 'expiresAt',
    refreshAt: 'refreshAt',
    tokenFile: 'tokenFile',
    targetKind: 'targetKind',
    id: 'id',
  },
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (query, part, index) =>
        `${query}${part}${index < values.length ? String(values[index]) : ''}`,
      '',
    ),
  ),
}));

import {
  primeSandboxOidcTargets,
  cleanupSandboxOidcTargetsForCloudJob,
  refreshDueSandboxOidcTargets,
} from '../sandbox-oidc';

const baseRow = {
  environmentId: 'env_1',
  runId: 42,
  computeProvider: 'modal',
  computeProviderId: 'sb_1',
  targetKind: 'custom',
  audience: 'audience-1',
  awsRoleArn: null,
  awsRegion: null,
  refreshAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-01T00:05:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
} as const;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    ...baseRow,
    id: 'row-1',
    tokenFile: '/tmp/token',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFiles.mockResolvedValue(undefined);
  mockRunCommand.mockResolvedValue({ exitCode: 0 });
  mockGetInstanceStatus.mockResolvedValue({
    status: 'running',
    timeoutRemainingMs: 60_000,
  });
  mockFindManySandboxOidcTargets.mockResolvedValue([]);
  mockRecordCloudJobEvent.mockResolvedValue(undefined);
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
});

describe('primeSandboxOidcTargets', () => {
  beforeEach(async () => {
    const { getEnvironmentOidcTargets } = await import('@roomote/types');

    vi.mocked(getEnvironmentOidcTargets).mockReturnValue([
      {
        kind: 'custom',
        audience: 'audience-1',
        tokenFile: '/tmp/token',
      },
    ]);
  });

  it('records provider-neutral OIDC events and forwards task context for cloud jobs', async () => {
    await primeSandboxOidcTargets({
      taskId: 'task_1',
      environmentId: 'env_1',
      environmentConfig: { oidc: { custom: [] } } as never,
      computeProvider: 'modal',
      computeProviderId: 'modal_1',
      cloudJobId: 42,
    });

    expect(mockGetInstanceStatus).toHaveBeenCalledTimes(2);
    expect(mockRecordCloudJobEvent).toHaveBeenCalledTimes(4);
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        runId: 42,
        taskId: 'task_1',
        source: 'machine_oidc',
        eventType: 'started',
        message: 'Starting OIDC token file upload for modal:modal_1.',
        details: expect.objectContaining({
          operation: 'write_files',
          computeProvider: 'modal',
          computeProviderId: 'modal_1',
          instanceStatusSnapshot: expect.objectContaining({
            status: 'running',
            timeoutRemainingMs: 60_000,
          }),
          timeoutMs: 60_000,
          attempt: 1,
          maxAttempts: 2,
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: expect.stringContaining('Sandbox OIDC'),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({
        source: 'machine_oidc',
        eventType: 'completed',
        details: expect.objectContaining({
          operation: 'install_token_files',
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  it('records a failed write_files event with structured error details', async () => {
    mockWriteFiles.mockRejectedValue(new Error('write failed'));

    await expect(
      primeSandboxOidcTargets({
        taskId: 'task_1',
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      }),
    ).rejects.toThrow('write failed');

    expect(mockRunCommand).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledTimes(2);
    expect(mockRecordCloudJobEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: 'task_1',
        source: 'machine_oidc',
        eventType: 'failed',
        details: expect.objectContaining({
          operation: 'write_files',
          error: expect.objectContaining({
            name: 'Error',
            message: 'write failed',
          }),
        }),
      }),
    );
  });

  it('retries timeout-shaped writeFiles failures before giving up', async () => {
    vi.useFakeTimers();

    try {
      mockWriteFiles
        .mockRejectedValueOnce({
          name: 'TimeoutError',
          message: 'The operation was aborted due to timeout',
        })
        .mockResolvedValueOnce(undefined);

      const primePromise = primeSandboxOidcTargets({
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(primePromise).resolves.toEqual({ targetCount: 1 });
      expect(mockWriteFiles).toHaveBeenCalledTimes(2);
      expect(mockRunCommand).toHaveBeenCalledTimes(1);
      expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          source: 'machine_oidc',
          eventType: 'failed',
          details: expect.objectContaining({
            operation: 'write_files',
            attempt: 1,
            maxAttempts: 2,
            retryable: true,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry non-timeout writeFiles errors', async () => {
    mockWriteFiles.mockRejectedValue(new Error('permission denied'));

    await expect(
      primeSandboxOidcTargets({
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      }),
    ).rejects.toThrow('permission denied');

    expect(mockWriteFiles).toHaveBeenCalledTimes(1);
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('retries timeout-shaped install failures', async () => {
    vi.useFakeTimers();

    try {
      mockRunCommand
        .mockRejectedValueOnce({
          name: 'TimeoutError',
          message: 'The operation was aborted due to timeout',
        })
        .mockResolvedValueOnce({ exitCode: 0 });

      const primePromise = primeSandboxOidcTargets({
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(primePromise).resolves.toEqual({ targetCount: 1 });
      expect(mockWriteFiles).toHaveBeenCalledTimes(2);
      expect(mockRunCommand).toHaveBeenCalledTimes(2);
      expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          source: 'machine_oidc',
          eventType: 'failed',
          details: expect.objectContaining({
            operation: 'install_token_files',
            attempt: 1,
            maxAttempts: 2,
            retryable: true,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records only failed telemetry when install exits nonzero', async () => {
    mockRunCommand.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'install failed',
    });

    await expect(
      primeSandboxOidcTargets({
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      }),
    ).rejects.toThrow('install failed');

    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'machine_oidc',
        eventType: 'failed',
        details: expect.objectContaining({
          operation: 'install_token_files',
          attempt: 1,
          maxAttempts: 2,
          retryable: false,
          error: expect.objectContaining({
            name: 'SandboxOidcCommandExitError',
            message: expect.stringContaining('install failed'),
            context: { exitCode: 1 },
          }),
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'machine_oidc',
        eventType: 'completed',
        details: expect.objectContaining({
          operation: 'install_token_files',
        }),
      }),
    );
  });

  it('rewrites temp files before retrying an install that timed out', async () => {
    vi.useFakeTimers();

    let tempFilePresent = false;
    let didTimeout = false;

    try {
      mockWriteFiles.mockImplementation(async ({ files }) => {
        tempFilePresent = Array.isArray(files) && files.length > 0;
      });
      mockRunCommand.mockImplementation(async () => {
        if (!tempFilePresent) {
          return {
            exitCode: 1,
            stderr: 'missing temp file',
          };
        }

        tempFilePresent = false;

        if (!didTimeout) {
          didTimeout = true;
          throw {
            name: 'TimeoutError',
            message: 'The operation was aborted due to timeout',
          };
        }

        return { exitCode: 0 };
      });

      const primePromise = primeSandboxOidcTargets({
        environmentId: 'env_1',
        environmentConfig: { oidc: { custom: [] } } as never,
        computeProvider: 'modal',
        computeProviderId: 'sb_1',
        cloudJobId: 42,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(primePromise).resolves.toEqual({ targetCount: 1 });
      expect(mockWriteFiles).toHaveBeenCalledTimes(2);
      expect(mockRunCommand).toHaveBeenCalledTimes(2);

      expect(mockWriteFiles.mock.calls[0]?.[0]).toMatchObject({
        instanceId: 'sb_1',
      });
      expect(mockWriteFiles.mock.calls[1]?.[0]).toMatchObject({
        instanceId: 'sb_1',
      });
      expect(mockWriteFiles.mock.calls[1]?.[0]?.files).toEqual(
        mockWriteFiles.mock.calls[0]?.[0]?.files,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cleanupSandboxOidcTargetsForCloudJob', () => {
  beforeEach(() => {
    mockFindManySandboxOidcTargets.mockResolvedValue([makeRow()]);
  });

  it('preserves cleanup rows when file removal fails but the instance is still running', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 1,
      stderr: 'transient cleanup failure',
    });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'running',
      timeoutRemainingMs: 60_000,
    });

    await expect(cleanupSandboxOidcTargetsForCloudJob(42)).rejects.toThrow(
      'Failed to remove sandbox OIDC files',
    );

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes cleanup rows when file removal fails after the instance has stopped', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 1,
      stderr: 'instance already gone',
    });
    mockGetInstanceStatus.mockResolvedValue({
      status: 'stopped',
      timeoutRemainingMs: 0,
    });

    await expect(cleanupSandboxOidcTargetsForCloudJob(42)).resolves.toEqual(
      undefined,
    );

    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it('deletes cleanup rows when status lookup reports the sandbox is missing', async () => {
    mockRunCommand.mockResolvedValue({
      exitCode: 1,
      stderr: 'instance already gone',
    });
    mockGetInstanceStatus.mockRejectedValue({
      response: { status: 404 },
      message: 'Sandbox sb_1 was not found.',
    });

    await expect(cleanupSandboxOidcTargetsForCloudJob(42)).resolves.toEqual(
      undefined,
    );

    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });
});

describe('refreshDueSandboxOidcTargets', () => {
  beforeEach(async () => {
    const { getEnvironmentOidcTargets } = await import('@roomote/types');

    vi.mocked(getEnvironmentOidcTargets).mockReturnValue([
      {
        kind: 'custom',
        audience: 'audience-1',
        tokenFile: '/tmp/token',
      },
    ]);

    mockFindManySandboxOidcTargets.mockResolvedValue([]);
    mockEnvironmentFindFirst.mockResolvedValue({
      id: 'env_1',
      config: {
        version: 1,
        name: 'OIDC Test Workspace',
        repos: [
          {
            id: 'app',
            repository: 'acme/app',
            path: 'app',
          },
        ],
        primaryRepo: 'app',
        runtime: {
          devcontainer: {
            type: 'reference',
            repo: 'app',
            path: '.devcontainer/devcontainer.json',
          },
        },
        identity: {
          oidc: {
            custom: [
              {
                audience: 'audience-1',
                tokenFile: '/tmp/token',
              },
            ],
          },
        },
      },
    });
    mockCloudJobFindFirst.mockImplementation(({ where: _where }) => {
      return Promise.resolve({
        id: 42,
        vendor: 'modal',
        machineId: 'sb_1',
        payload: {},
        status: 'running',
      });
    });
  });

  it('cleans claimed rows when the instance is already stopped before refresh begins', async () => {
    mockDbExecute.mockResolvedValue([
      makeRow({ id: 'row-1', computeProviderId: 'sb_1', runId: 42 }),
    ]);
    mockGetInstanceStatus.mockResolvedValue({
      status: 'stopped',
      timeoutRemainingMs: 0,
    });

    const result = await refreshDueSandboxOidcTargets({
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result).toEqual({
      refreshedMachines: 0,
      cleanedMachines: 1,
      failedMachines: 0,
    });
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it('cleans claimed rows when the instance has already failed before refresh begins', async () => {
    mockDbExecute.mockResolvedValue([
      makeRow({ id: 'row-1', computeProviderId: 'sb_1', runId: 42 }),
    ]);
    mockGetInstanceStatus.mockResolvedValue({
      status: 'failed',
      timeoutRemainingMs: 0,
    });

    const result = await refreshDueSandboxOidcTargets({
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result).toEqual({
      refreshedMachines: 0,
      cleanedMachines: 1,
      failedMachines: 0,
    });
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it('cleans claimed rows when refresh discovers the instance is missing', async () => {
    mockDbExecute.mockResolvedValue([
      makeRow({ id: 'row-1', computeProviderId: 'sb_1', runId: 42 }),
    ]);
    mockGetInstanceStatus.mockRejectedValue({
      response: { status: 404 },
      message: 'Sandbox sb_1 was not found.',
    });

    const result = await refreshDueSandboxOidcTargets({
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result).toEqual({
      refreshedMachines: 0,
      cleanedMachines: 1,
      failedMachines: 0,
    });
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockWriteFiles).not.toHaveBeenCalled();
  });

  it('continues refreshing other machines when one machine fails', async () => {
    const { createSandboxOidcToken } = await import('@roomote/auth');
    const { getEnvironmentOidcTargets } = await import('@roomote/types');

    mockDbExecute.mockResolvedValue([
      makeRow({ id: 'row-1', computeProviderId: 'sb_1', runId: 42 }),
      makeRow({ id: 'row-2', computeProviderId: 'sb_2', runId: 43 }),
    ]);
    mockCloudJobFindFirst.mockResolvedValueOnce({
      id: 42,
      vendor: 'modal',
      machineId: 'sb_1',
      payload: {},
      status: 'running',
    });
    mockCloudJobFindFirst.mockResolvedValueOnce({
      id: 43,
      vendor: 'modal',
      machineId: 'sb_2',
      payload: {},
      status: 'running',
    });
    mockRunCommand.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'install failed',
    });
    mockRunCommand.mockResolvedValueOnce({ exitCode: 0 });

    const result = await refreshDueSandboxOidcTargets({
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result).toEqual({
      refreshedMachines: 1,
      cleanedMachines: 0,
      failedMachines: 1,
    });
    expect(getEnvironmentOidcTargets).toHaveBeenCalledTimes(4);
    expect(createSandboxOidcToken).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env_1',
        audience: 'audience-1',
      }),
    );
    expect(mockWriteFiles).toHaveBeenCalledTimes(2);
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('claims due targets by machine group limit instead of raw row limit', async () => {
    mockDbExecute.mockResolvedValue([]);

    await refreshDueSandboxOidcTargets({
      limit: 7,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const query = String(mockDbExecute.mock.calls[0]?.[0] ?? '');

    expect(query).toContain('WITH due_machines AS');
    expect(query).toContain('GROUP BY');
    expect(query).toContain('LIMIT 7');
    expect(query).toContain('FOR UPDATE OF targets SKIP LOCKED');
  });
});
