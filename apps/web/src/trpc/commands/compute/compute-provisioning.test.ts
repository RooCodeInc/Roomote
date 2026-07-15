import {
  WORKER_RUNTIME_SCHEMA_VERSION,
  type SetupNewComputeProvisioningState,
  type SetupNewState,
} from '@roomote/types';

const {
  mockDbTransaction,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockBuildE2bWorkerTemplate,
  mockResolveComputeProviderEnvValues,
  mockUpsertDeploymentEnvironmentVariables,
  mockQueuePersistedTaskRun,
  mockDbUpdateSet,
  mockWaitingRuns,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
  mockBuildE2bWorkerTemplate: vi.fn(),
  mockResolveComputeProviderEnvValues: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockQueuePersistedTaskRun: vi.fn().mockResolvedValue(undefined),
  mockDbUpdateSet: vi.fn(),
  mockWaitingRuns: { current: [] as unknown[] },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  queuePersistedTaskRun: mockQueuePersistedTaskRun,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {
    transaction: mockDbTransaction,
    update: vi.fn(() => ({
      set: mockDbUpdateSet,
    })),
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
  resolveComputeProviderEnvValues: mockResolveComputeProviderEnvValues,
  taskRuns: {
    vendor: 'task_runs.vendor',
    status: 'task_runs.status',
    taskPhase: 'task_runs.task_phase',
  },
}));

vi.mock('@roomote/compute-providers', () => ({
  buildBlaxelWorkerImage: vi.fn(),
  buildE2bWorkerTemplate: mockBuildE2bWorkerTemplate,
  registerDaytonaWorkerSnapshot: vi.fn(),
  deriveBlaxelWorkerImageName: (imageRef: string) =>
    `roomote-worker-${imageRef.slice(imageRef.lastIndexOf(':') + 1)}`,
  deriveE2bWorkerTemplateRef: (imageRef: string) =>
    `roomote-worker:${imageRef.slice(imageRef.lastIndexOf(':') + 1)}`,
  deriveDaytonaWorkerSnapshotName: (imageRef: string) =>
    `roomote-worker-${imageRef.slice(imageRef.lastIndexOf(':') + 1)}`,
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

import {
  persistComputeProvisioning,
  prepareComputeProvisioningStart,
  reconcileComputeProvisioningOnStartup,
  runComputeProvisioning,
} from './compute-provisioning';

function createExecutorMock(existingState: Partial<SetupNewState>) {
  const captured: { setupNewState?: SetupNewState } = {};

  return {
    captured,
    executor: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ setupNewState: existingState }],
          }),
        }),
      }),
      insert: () => ({
        values: (values: { setupNewState: SetupNewState }) => {
          captured.setupNewState = values.setupNewState;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as never,
  };
}

const STALE_STARTED_AT = '2026-07-03T00:00:00.000Z';

const staleBuildingEntry: SetupNewComputeProvisioningState = {
  status: 'building',
  runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
  imageRef: 'registry.example.com/worker:old',
  templateRef: 'roomote-worker-old',
  error: null,
  startedAt: STALE_STARTED_AT,
  finishedAt: null,
};

describe('persistComputeProvisioning', () => {
  it('gives a new building attempt a fresh startedAt instead of inheriting a stale one', async () => {
    const { captured, executor } = createExecutorMock({
      daytonaSnapshotBuild: staleBuildingEntry,
    });

    const freshStartedAt = new Date().toISOString();

    await persistComputeProvisioning(
      'daytona',
      {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:new',
        templateRef: 'roomote-worker-new',
        error: null,
        startedAt: freshStartedAt,
        finishedAt: null,
      },
      executor,
    );

    expect(captured.setupNewState?.daytonaSnapshotBuild).toMatchObject({
      status: 'building',
      startedAt: freshStartedAt,
    });
  });

  it('preserves the attempt startedAt on terminal writes', async () => {
    const { captured, executor } = createExecutorMock({
      daytonaSnapshotBuild: staleBuildingEntry,
    });

    await persistComputeProvisioning(
      'daytona',
      {
        status: 'failed',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:old',
        templateRef: null,
        error: 'boom',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      executor,
    );

    expect(captured.setupNewState?.daytonaSnapshotBuild).toMatchObject({
      status: 'failed',
      error: 'boom',
      startedAt: STALE_STARTED_AT,
    });
  });

  it('writes provider state to the provider-specific field only', async () => {
    const { captured, executor } = createExecutorMock({
      e2bTemplateBuild: staleBuildingEntry,
    });

    const freshStartedAt = new Date().toISOString();

    await persistComputeProvisioning(
      'e2b',
      {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:new',
        templateRef: 'roomote-worker:new',
        error: null,
        startedAt: freshStartedAt,
        finishedAt: null,
      },
      executor,
    );

    expect(captured.setupNewState?.e2bTemplateBuild?.startedAt).toBe(
      freshStartedAt,
    );
    expect(captured.setupNewState?.daytonaSnapshotBuild).toBeNull();
  });
});

describe('prepareComputeProvisioningStart', () => {
  it('marks a fresh pending run and returns the detached start payload', async () => {
    const markPending = vi.fn();

    const result = await prepareComputeProvisioningStart({
      provider: 'e2b',
      providerStatus: {
        provider: 'e2b',
        label: 'E2B',
        description: '',
        supportsSnapshots: true,
        comment: 'Recommended',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'E2B_API_KEY',
            label: 'E2B API Key',
            secret: true,
            category: 'credential',
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: false,
          },
          {
            envVarName: 'E2B_TEMPLATE_ID',
            label: 'Worker Template ID',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: null,
      dockerWorkerImage: 'registry.example.com/worker:tag',
      markPending,
    });

    expect(result).toEqual({
      fieldPending: true,
      provisionable: true,
      start: {
        provider: 'e2b',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
      },
    });
    expect(markPending).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'building',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
      }),
    );
  });

  it('does not mark a second run while a non-stale build is already in flight', async () => {
    const markPending = vi.fn();
    const startedAt = new Date().toISOString();

    const result = await prepareComputeProvisioningStart({
      provider: 'daytona',
      providerStatus: {
        provider: 'daytona',
        label: 'Daytona',
        description: '',
        supportsSnapshots: true,
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'DAYTONA_API_KEY',
            label: 'Daytona API Key',
            secret: true,
            category: 'credential',
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: false,
          },
          {
            envVarName: 'DAYTONA_SNAPSHOT_NAME',
            label: 'Worker Snapshot Name',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker-tag',
        error: null,
        startedAt,
        finishedAt: null,
      },
      dockerWorkerImage: 'registry.example.com/worker:tag',
      markPending,
    });

    expect(result).toEqual({
      fieldPending: true,
      provisionable: true,
      start: null,
    });
    expect(markPending).not.toHaveBeenCalled();
  });

  it('rebuilds a saved artifact when its worker image is from an older release', async () => {
    const markPending = vi.fn();
    const result = await prepareComputeProvisioningStart({
      provider: 'e2b',
      providerStatus: {
        provider: 'e2b',
        label: 'E2B',
        description: '',
        supportsSnapshots: true,
        comment: 'Recommended',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: true,
        configSatisfied: true,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'E2B_TEMPLATE_ID',
            label: 'Worker Template ID',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: {
        status: 'succeeded',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:old',
        templateRef: 'roomote-worker:old',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      dockerWorkerImage: 'registry.example.com/worker:new',
      markPending,
    });

    expect(result.start).toMatchObject({
      provider: 'e2b',
      imageRef: 'registry.example.com/worker:new',
    });
    expect(markPending).toHaveBeenCalledOnce();
  });

  it('rebuilds a saved artifact when the runtime schema metadata is missing', async () => {
    const markPending = vi.fn();
    const result = await prepareComputeProvisioningStart({
      provider: 'e2b',
      providerStatus: {
        provider: 'e2b',
        label: 'E2B',
        description: '',
        supportsSnapshots: true,
        comment: 'Recommended',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: true,
        configSatisfied: true,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'E2B_TEMPLATE_ID',
            label: 'Worker Template ID',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: {
        status: 'succeeded',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } as SetupNewComputeProvisioningState,
      dockerWorkerImage: 'registry.example.com/worker:tag',
      markPending,
    });

    expect(result.start).not.toBeNull();
  });

  it('keeps a saved artifact when image and runtime schema are current', async () => {
    const markPending = vi.fn();
    const result = await prepareComputeProvisioningStart({
      provider: 'e2b',
      providerStatus: {
        provider: 'e2b',
        label: 'E2B',
        description: '',
        supportsSnapshots: true,
        comment: 'Recommended',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: true,
        configSatisfied: true,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'E2B_TEMPLATE_ID',
            label: 'Worker Template ID',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: {
        status: 'succeeded',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
      dockerWorkerImage: 'registry.example.com/worker:tag',
      markPending,
    });

    expect(result).toEqual({
      fieldPending: false,
      provisionable: false,
      start: null,
    });
    expect(markPending).not.toHaveBeenCalled();
  });

  it('uses the development hosted worker image for provider artifact provisioning', async () => {
    const markPending = vi.fn();

    const result = await prepareComputeProvisioningStart({
      provider: 'e2b',
      providerStatus: {
        provider: 'e2b',
        label: 'E2B',
        description: '',
        supportsSnapshots: true,
        comment: 'Recommended',
        runtimeConfigSatisfied: false,
        savedConfigSatisfied: false,
        configSatisfied: false,
        infrastructureSatisfied: true,
        fields: [
          {
            envVarName: 'E2B_API_KEY',
            label: 'E2B API Key',
            secret: true,
            category: 'credential',
            runtimeSatisfied: false,
            savedSatisfied: true,
            defaultSatisfied: false,
            setupProvisionable: false,
          },
          {
            envVarName: 'E2B_TEMPLATE_ID',
            label: 'Worker Template ID',
            category: 'infrastructure',
            advanced: true,
            runtimeSatisfied: false,
            savedSatisfied: false,
            defaultSatisfied: false,
            setupProvisionable: true,
          },
        ],
      },
      existingState: null,
      dockerWorkerImage: 'roomote-worker:local',
      runtimeEnv: { NODE_ENV: 'development' },
      markPending,
    });

    expect(result).toEqual({
      fieldPending: true,
      provisionable: true,
      start: {
        provider: 'e2b',
        imageRef: 'ghcr.io/roocodeinc/roomote-worker:develop',
        templateRef: 'roomote-worker:develop',
      },
    });
    expect(markPending).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRef: 'ghcr.io/roocodeinc/roomote-worker:develop',
        templateRef: 'roomote-worker:develop',
      }),
    );
  });
});

describe('reconcileComputeProvisioningOnStartup', () => {
  it('takes a deployment-wide claim and skips an already-current artifact', async () => {
    vi.stubEnv('DOCKER_WORKER_IMAGE', 'registry.example.com/worker:tag');
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
      'E2B_API_KEY',
      'E2B_TEMPLATE_ID',
    ]);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      E2B_TEMPLATE_ID: 'roomote-worker:tag',
    });
    const execute = vi.fn();
    const { executor } = createExecutorMock({
      e2bTemplateBuild: {
        status: 'succeeded',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    });
    const tx = executor as unknown as { execute: typeof execute };
    tx.execute = execute;
    mockDbTransaction.mockImplementation(async (callback) => callback(tx));

    await reconcileComputeProvisioningOnStartup();

    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('runComputeProvisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWaitingRuns.current = [];
    mockDbUpdateSet.mockImplementation(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => mockWaitingRuns.current),
      })),
    }));
  });

  it('does not activate an artifact after a newer desired build supersedes it', async () => {
    mockResolveComputeProviderEnvValues.mockResolvedValue({
      E2B_API_KEY: 'key',
    });
    mockBuildE2bWorkerTemplate.mockResolvedValue({
      templateRef: 'roomote-worker:old-r2',
      templateId: 'template-id',
      buildId: 'build-id',
      tags: [],
    });
    const execute = vi.fn();
    const { captured, executor } = createExecutorMock({
      e2bTemplateBuild: {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:new',
        templateRef: 'roomote-worker:new-r2',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
    const tx = executor as unknown as { execute: typeof execute };
    tx.execute = execute;
    mockDbTransaction.mockImplementation(async (callback) => callback(tx));

    await runComputeProvisioning({
      provider: 'e2b',
      userId: null,
      imageRef: 'registry.example.com/worker:old',
      templateRef: 'roomote-worker:old-r2',
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    expect(captured.setupNewState).toBeUndefined();
  });

  it('dispatches queued onboarding runs after first-time provisioning succeeds', async () => {
    mockResolveComputeProviderEnvValues.mockResolvedValue({
      E2B_API_KEY: 'key',
    });
    mockBuildE2bWorkerTemplate.mockResolvedValue({
      templateRef: 'roomote-worker:tag-r2',
      templateId: 'template-id',
      buildId: 'build-id',
      tags: [],
    });
    const execute = vi.fn();
    const { executor } = createExecutorMock({
      e2bTemplateBuild: {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag-r2',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
    const tx = executor as unknown as { execute: typeof execute };
    tx.execute = execute;
    mockDbTransaction.mockImplementation(async (callback) => callback(tx));
    const waitingRun = {
      id: 42,
      taskId: 'task-onboarding',
      status: 'pending',
      taskPhase: null,
      error: null,
    };
    mockWaitingRuns.current = [waitingRun];

    await runComputeProvisioning({
      provider: 'e2b',
      userId: null,
      imageRef: 'registry.example.com/worker:tag',
      templateRef: 'roomote-worker:tag-r2',
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        values: [{ name: 'E2B_TEMPLATE_ID', value: 'roomote-worker:tag-r2' }],
      }),
    );
    expect(mockQueuePersistedTaskRun).toHaveBeenCalledWith(waitingRun);
  });

  it('publishes provisioning failures to queued tasks and clears them on retry', async () => {
    mockResolveComputeProviderEnvValues.mockResolvedValue({
      E2B_API_KEY: 'key',
    });
    mockBuildE2bWorkerTemplate.mockRejectedValue(new Error('Access denied'));
    const execute = vi.fn();
    const { executor } = createExecutorMock({
      e2bTemplateBuild: {
        status: 'building',
        runtimeSchemaVersion: WORKER_RUNTIME_SCHEMA_VERSION,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag-r2',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    });
    const tx = executor as unknown as { execute: typeof execute };
    tx.execute = execute;
    mockDbTransaction.mockImplementation(async (callback) => callback(tx));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runComputeProvisioning({
        provider: 'e2b',
        userId: null,
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag-r2',
      });

      expect(mockDbUpdateSet).toHaveBeenNthCalledWith(1, { error: null });
      expect(mockDbUpdateSet).toHaveBeenCalledWith({
        error:
          'Sandbox provider provisioning failed: Access denied Retry provisioning in Settings → Sandboxes.',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
