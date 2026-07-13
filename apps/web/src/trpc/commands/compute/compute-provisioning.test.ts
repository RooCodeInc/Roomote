import type {
  SetupNewComputeProvisioningState,
  SetupNewState,
} from '@roomote/types';

const {
  mockDbTransaction,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { transaction: mockDbTransaction },
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
  resolveComputeProviderEnvValues: vi.fn(),
}));

vi.mock('@roomote/compute-providers', () => ({
  buildBlaxelWorkerImage: vi.fn(),
  buildE2bWorkerTemplate: vi.fn(),
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
  upsertDeploymentEnvironmentVariables: vi.fn(),
}));

import {
  persistComputeProvisioning,
  prepareComputeProvisioningStart,
  reconcileComputeProvisioningOnStartup,
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
  runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        runtimeSchemaVersion: 1,
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
        imageRef: 'ghcr.io/roocodeinc/roomote-worker:latest',
        templateRef: 'roomote-worker:latest',
      },
    });
    expect(markPending).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRef: 'ghcr.io/roocodeinc/roomote-worker:latest',
        templateRef: 'roomote-worker:latest',
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
        runtimeSchemaVersion: 1,
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
