import { WORKER_RUNTIME_SCHEMA_VERSION } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

const {
  mockDbSelect,
  mockDbInsert,
  mockDbTransaction,
  mockDbDelete,
  mockUpsertDeploymentEnvironmentVariables,
  mockGetPersistedEnvironmentVariableNames,
  mockGetPersistedEnvironmentVariableValues,
  mockResolveSavedWorkerImage,
  mockRunComputeProvisioning,
  mockAcquireComputeProvisioningLock,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockDbDelete: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn().mockResolvedValue([]),
  mockGetPersistedEnvironmentVariableValues: vi.fn().mockResolvedValue({}),
  mockResolveSavedWorkerImage: vi.fn().mockResolvedValue(null),
  mockRunComputeProvisioning: vi.fn().mockResolvedValue(undefined),
  mockAcquireComputeProvisioningLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./compute-provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./compute-provisioning')>();

  return {
    ...actual,
    acquireComputeProvisioningLock: mockAcquireComputeProvisioningLock,
    runComputeProvisioning: mockRunComputeProvisioning,
  };
});

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    transaction: mockDbTransaction,
    delete: mockDbDelete,
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  environmentVariables: { name: 'env.name', userId: 'env.user_id' },
  eq: vi.fn(),
  inArray: vi.fn((field: unknown, values: unknown) => ({
    op: 'inArray',
    field,
    values,
  })),
  isNull: vi.fn((field: unknown) => ({ op: 'isNull', field })),
  resolveSavedWorkerImage: mockResolveSavedWorkerImage,
  purgeSavedDeploymentWorkerImage: vi.fn(async () => undefined),
}));

vi.mock('../environment-variables', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }
  },
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
}));

import {
  clearComputeConfigCommand,
  getComputeStatusCommand,
  saveComputeConfigCommand,
  setDefaultComputeProviderCommand,
  setLocalDockerEnabledCommand,
} from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'compute-test-user',
    isAdmin: true,
    name: 'Compute Tester',
    primaryEmail: 'compute@example.com',
    resource: {
      username: 'compute-tester',
      fullName: 'Compute Tester',
      firstName: 'Compute',
      lastName: 'Tester',
      primaryEmailAddress: { id: '1', emailAddress: 'compute@example.com' },
      emailAddresses: [{ id: '1', emailAddress: 'compute@example.com' }],
      imageUrl: 'https://example.com/avatar.png',
      createdAt: new Date(),
    },
    ...overrides,
  } as UserAuthSuccess;
}

function createSelectChain(rows: Array<Record<string, unknown>> = []) {
  return () => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  });
}

function createInsertChain() {
  return vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(async () => undefined),
    })),
  }));
}

describe('compute commands', () => {
  // These vars can leak in from the sandbox environment; clear them so the
  // command behavior (runtime env locks a field) is deterministic per test.
  const MANAGED_COMPUTE_ENV_VARS = [
    'MODAL_TOKEN_ID',
    'MODAL_TOKEN_SECRET',
    'MODAL_BASE_IMAGE_REF',
    'MODAL_REGIONS',
    'E2B_API_KEY',
    'E2B_TEMPLATE_ID',
    'E2B_DOMAIN',
    'DAYTONA_API_KEY',
    'DAYTONA_SNAPSHOT_NAME',
    'DAYTONA_API_URL',
    'DAYTONA_TARGET',
    'BL_API_KEY',
    'BL_WORKSPACE',
    'BLAXEL_IMAGE',
    'BLAXEL_REGION',
    'BLAXEL_STANDBY_MAX_COUNT',
    'BLAXEL_STANDBY_MAX_AGE_HOURS',
    'DOCKER_STANDBY_MAX_COUNT',
    'DOCKER_STANDBY_MAX_AGE_HOURS',
    'DOCKER_WORKER_IMAGE',
    'RELEASE_VERSION',
  ];
  const originalComputeEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const name of MANAGED_COMPUTE_ENV_VARS) {
      originalComputeEnv[name] = process.env[name];
    }
  });

  afterAll(() => {
    for (const name of MANAGED_COMPUTE_ENV_VARS) {
      if (originalComputeEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalComputeEnv[name];
      }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect.mockImplementation(createSelectChain());
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockResolveSavedWorkerImage.mockResolvedValue(null);
    for (const name of MANAGED_COMPUTE_ENV_VARS) {
      delete process.env[name];
    }
  });

  describe('getComputeStatusCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        getComputeStatusCommand(buildMockAuth({ isAdmin: false })),
      ).rejects.toThrow('Unauthorized');
    });

    it('returns provider status from persisted env var names and config', async () => {
      mockDbSelect.mockImplementation(
        createSelectChain([
          { runtimeComputeConfig: { defaultProvider: 'modal' } },
        ]),
      );
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'MODAL_TOKEN_ID',
        'MODAL_TOKEN_SECRET',
        'MODAL_BASE_IMAGE_REF',
      ]);

      const status = await getComputeStatusCommand(buildMockAuth());

      expect(status.persistedDefaultProvider).toBe('modal');

      const modal = status.providers.find((p) => p.provider === 'modal');
      expect(modal?.savedConfigSatisfied).toBe(true);
      expect(modal?.configSatisfied).toBe(true);

      const e2b = status.providers.find((p) => p.provider === 'e2b');
      expect(e2b?.savedConfigSatisfied).toBe(false);
    });
  });

  describe('saveComputeConfigCommand', () => {
    beforeEach(() => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          select: createSelectChain(),
          insert: createInsertChain(),
        } as never);
      });
      process.env.E2B_TEMPLATE_ID = '';
      process.env.DAYTONA_SNAPSHOT_NAME = '';
    });

    afterEach(() => {
      delete process.env.E2B_TEMPLATE_ID;
      delete process.env.DAYTONA_SNAPSHOT_NAME;
    });

    it('persists credentials and ignores submitted auto-provisioned artifacts', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'e2b',
        values: {
          E2B_API_KEY: 'e2b-key',
          E2B_TEMPLATE_ID: 'manual-template',
        },
      });

      const values = mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]
        ?.values as Array<{ name: string; value: string }>;
      expect(values).toEqual(
        expect.arrayContaining([{ name: 'E2B_API_KEY', value: 'e2b-key' }]),
      );
      expect(values.map((entry) => entry.name)).not.toContain(
        'E2B_TEMPLATE_ID',
      );
      // Manual form template/snapshot overrides are ignored; provisioning still
      // runs when a registry-qualified worker image is available.
    });

    it('persists valid Docker standby retention settings', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'docker',
        values: {
          DOCKER_STANDBY_MAX_COUNT: '4',
          DOCKER_STANDBY_MAX_AGE_HOURS: '12',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        {
          userId: 'compute-test-user',
          values: [
            { name: 'DOCKER_STANDBY_MAX_COUNT', value: '4' },
            { name: 'DOCKER_STANDBY_MAX_AGE_HOURS', value: '12' },
          ],
        },
      );
    });

    it('rejects standby retention values outside provider limits', async () => {
      await expect(
        saveComputeConfigCommand(buildMockAuth(), {
          provider: 'blaxel',
          values: { BLAXEL_STANDBY_MAX_AGE_HOURS: '169' },
        }),
      ).rejects.toThrow('Retention period (hours) must be at most 168.');
    });

    it('uses a submitted worker image to derive Modal base image without sticky persist', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_TOKEN_ID: 'token-id',
          MODAL_TOKEN_SECRET: 'token-secret',
          DOCKER_WORKER_IMAGE: 'registry.example.com/worker:tag',
        },
      });

      const values = mockUpsertDeploymentEnvironmentVariables.mock.calls[0]?.[1]
        ?.values as Array<{ name: string; value: string }>;
      expect(values).toEqual(
        expect.arrayContaining([
          {
            name: 'MODAL_BASE_IMAGE_REF',
            value: 'registry.example.com/worker:tag',
          },
        ]),
      );
      expect(values.map((entry) => entry.name)).not.toContain(
        'DOCKER_WORKER_IMAGE',
      );
    });

    it('throws when a required credential is missing and not satisfied', async () => {
      await expect(
        saveComputeConfigCommand(buildMockAuth(), {
          provider: 'modal',
          values: { MODAL_TOKEN_ID: 'token-id' },
        }),
      ).rejects.toThrow(
        'Enter the required Modal configuration values to continue.',
      );

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
    });

    it('does not require fields already satisfied by env', async () => {
      process.env.MODAL_TOKEN_ID = 'env-token-id';

      try {
        await expect(
          saveComputeConfigCommand(buildMockAuth(), {
            provider: 'modal',
            values: { MODAL_TOKEN_SECRET: 'token-secret' },
          }),
        ).resolves.toBeUndefined();
      } finally {
        delete process.env.MODAL_TOKEN_ID;
      }
    });

    it('clears a saved optional non-secret field when the operator empties it', async () => {
      // Saved-only path: runtime MODAL_REGIONS would lock the field and
      // skip delete. MANAGED_COMPUTE_ENV_VARS already clears it per-test.
      delete process.env.MODAL_REGIONS;
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'MODAL_TOKEN_ID',
        'MODAL_TOKEN_SECRET',
        'MODAL_REGIONS',
      ]);
      const txWhere = vi.fn(async () => undefined);
      const txDelete = vi.fn(() => ({ where: txWhere }));
      const {
        and: txAnd,
        inArray: txInArray,
        isNull: txIsNull,
      } = await import('@roomote/db/server');

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          select: createSelectChain(),
          insert: createInsertChain(),
          delete: txDelete,
        } as never);
      });

      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_REGIONS: '',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).not.toHaveBeenCalled();
      expect(txDelete).toHaveBeenCalled();
      expect(txIsNull).toHaveBeenCalledWith('env.user_id');
      expect(txInArray).toHaveBeenCalledWith('env.name', ['MODAL_REGIONS']);
      expect(txAnd).toHaveBeenCalledWith(
        { op: 'isNull', field: 'env.user_id' },
        {
          op: 'inArray',
          field: 'env.name',
          values: ['MODAL_REGIONS'],
        },
      );
      expect(txWhere).toHaveBeenCalledWith({
        op: 'and',
        conditions: [
          { op: 'isNull', field: 'env.user_id' },
          {
            op: 'inArray',
            field: 'env.name',
            values: ['MODAL_REGIONS'],
          },
        ],
      });
    });

    it('does not block credential saves on missing env-only infrastructure', async () => {
      await expect(
        saveComputeConfigCommand(buildMockAuth(), {
          provider: 'e2b',
          values: { E2B_API_KEY: 'e2b-key' },
        }),
      ).resolves.toBeUndefined();

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: [{ name: 'E2B_API_KEY', value: 'e2b-key' }],
        }),
      );
    });

    it('starts the E2B template build when credentials are saved and a worker image is available', async () => {
      process.env.DOCKER_WORKER_IMAGE = 'registry.example.com/worker:tag';

      try {
        await saveComputeConfigCommand(buildMockAuth(), {
          provider: 'e2b',
          values: { E2B_API_KEY: 'e2b-key' },
        });
      } finally {
        delete process.env.DOCKER_WORKER_IMAGE;
      }

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: [{ name: 'E2B_API_KEY', value: 'e2b-key' }],
        }),
      );
      expect(mockRunComputeProvisioning).toHaveBeenCalledWith({
        provider: 'e2b',
        userId: 'compute-test-user',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
      });
    });

    it('starts the Daytona snapshot registration when credentials are saved and a worker image is available', async () => {
      process.env.DOCKER_WORKER_IMAGE = 'registry.example.com/worker:tag';

      try {
        await saveComputeConfigCommand(buildMockAuth(), {
          provider: 'daytona',
          values: { DAYTONA_API_KEY: 'daytona-key' },
        });
      } finally {
        delete process.env.DOCKER_WORKER_IMAGE;
      }

      expect(mockRunComputeProvisioning).toHaveBeenCalledWith({
        provider: 'daytona',
        userId: 'compute-test-user',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: `roomote-worker-tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
      });
    });

    it('starts the E2B template build from a submitted worker image', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'e2b',
        values: {
          E2B_API_KEY: 'e2b-key',
          DOCKER_WORKER_IMAGE: 'registry.example.com/worker:tag',
        },
      });

      expect(mockRunComputeProvisioning).toHaveBeenCalledWith({
        provider: 'e2b',
        userId: 'compute-test-user',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: `roomote-worker:tag-r${WORKER_RUNTIME_SCHEMA_VERSION}`,
      });
    });

    it('does not start provisioning without a registry-qualified worker image', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'e2b',
        values: { E2B_API_KEY: 'e2b-key' },
      });

      expect(mockRunComputeProvisioning).not.toHaveBeenCalled();
    });

    it('derives and persists the Modal base image ref from the worker image', async () => {
      process.env.DOCKER_WORKER_IMAGE = 'registry.example.com/worker:tag';

      try {
        await saveComputeConfigCommand(buildMockAuth(), {
          provider: 'modal',
          values: {
            MODAL_TOKEN_ID: 'token-id',
            MODAL_TOKEN_SECRET: 'token-secret',
          },
        });
      } finally {
        delete process.env.DOCKER_WORKER_IMAGE;
      }

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            {
              name: 'MODAL_BASE_IMAGE_REF',
              value: 'registry.example.com/worker:tag',
            },
          ]),
        }),
      );
    });

    it('derives and persists the Modal base image ref from RELEASE_VERSION when no worker image is set', async () => {
      process.env.RELEASE_VERSION = 'v1.2.3';

      try {
        await saveComputeConfigCommand(buildMockAuth(), {
          provider: 'modal',
          values: {
            MODAL_TOKEN_ID: 'token-id',
            MODAL_TOKEN_SECRET: 'token-secret',
          },
        });
      } finally {
        delete process.env.RELEASE_VERSION;
      }

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            {
              name: 'MODAL_BASE_IMAGE_REF',
              value: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
            },
          ]),
        }),
      );
    });
  });

  describe('clearComputeConfigCommand', () => {
    it('rejects non-admin users', async () => {
      await expect(
        clearComputeConfigCommand(buildMockAuth({ isAdmin: false }), {
          provider: 'modal',
        }),
      ).rejects.toThrow('Unauthorized');
    });

    it('deletes credential and provider-specific infrastructure env vars, not the shared worker image', async () => {
      const txWhere = vi.fn(async () => undefined);
      const txDelete = vi.fn(() => ({ where: txWhere }));
      const {
        and: txAnd,
        inArray: txInArray,
        isNull: txIsNull,
      } = await import('@roomote/db/server');

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({ delete: txDelete } as never);
      });

      await clearComputeConfigCommand(buildMockAuth(), { provider: 'modal' });

      expect(txDelete).toHaveBeenCalled();
      expect(txInArray).toHaveBeenCalledWith('env.name', [
        'MODAL_TOKEN_ID',
        'MODAL_TOKEN_SECRET',
        'MODAL_BASE_IMAGE_REF',
        'MODAL_REGIONS',
      ]);
      expect(txIsNull).toHaveBeenCalledWith('env.user_id');
      expect(txAnd).toHaveBeenCalledWith(
        { op: 'isNull', field: 'env.user_id' },
        {
          op: 'inArray',
          field: 'env.name',
          values: [
            'MODAL_TOKEN_ID',
            'MODAL_TOKEN_SECRET',
            'MODAL_BASE_IMAGE_REF',
            'MODAL_REGIONS',
          ],
        },
      );
      expect(txWhere).toHaveBeenCalledWith({
        op: 'and',
        conditions: [
          { op: 'isNull', field: 'env.user_id' },
          {
            op: 'inArray',
            field: 'env.name',
            values: [
              'MODAL_TOKEN_ID',
              'MODAL_TOKEN_SECRET',
              'MODAL_BASE_IMAGE_REF',
              'MODAL_REGIONS',
            ],
          },
        ],
      });
    });

    it('deletes Docker standby retention settings', async () => {
      const txWhere = vi.fn(async () => undefined);
      const txDelete = vi.fn(() => ({ where: txWhere }));
      const { inArray: txInArray } = await import('@roomote/db/server');

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({ delete: txDelete } as never);
      });

      await clearComputeConfigCommand(buildMockAuth(), { provider: 'docker' });

      expect(txInArray).toHaveBeenCalledWith('env.name', [
        'DOCKER_STANDBY_MAX_COUNT',
        'DOCKER_STANDBY_MAX_AGE_HOURS',
      ]);
      expect(txWhere).toHaveBeenCalled();
    });
  });

  describe('setDefaultComputeProviderCommand', () => {
    it('rejects providers that are not configured', async () => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          select: createSelectChain(),
          insert: createInsertChain(),
        } as never);
      });

      await expect(
        setDefaultComputeProviderCommand(buildMockAuth(), {
          provider: 'modal',
        }),
      ).rejects.toThrow(
        'Configure Modal before making it the default sandbox provider.',
      );
    });

    it('persists the default for a configured provider', async () => {
      const txInsert = createInsertChain();

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          select: createSelectChain([
            {
              runtimeComputeConfig: {
                defaultProvider: null,
                excludedProviders: ['docker'],
              },
            },
          ]),
          insert: txInsert,
        } as never);
      });
      mockGetPersistedEnvironmentVariableNames.mockResolvedValue([
        'E2B_API_KEY',
        'E2B_TEMPLATE_ID',
      ]);

      const result = await setDefaultComputeProviderCommand(buildMockAuth(), {
        provider: 'e2b',
      });

      expect(result.runtimeComputeConfig).toEqual({
        defaultProvider: 'e2b',
        excludedProviders: ['docker'],
      });
      expect(txInsert).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('setLocalDockerEnabledCommand', () => {
    it('disables Docker and clears it as the persisted default', async () => {
      const txInsert = createInsertChain();

      mockDbTransaction.mockImplementation(async (callback) =>
        callback({
          select: createSelectChain([
            {
              runtimeComputeConfig: {
                defaultProvider: 'docker',
                excludedProviders: ['modal'],
              },
            },
          ]),
          insert: txInsert,
        } as never),
      );

      const result = await setLocalDockerEnabledCommand(buildMockAuth(), {
        enabled: false,
      });

      expect(result.runtimeComputeConfig).toEqual({
        defaultProvider: null,
        excludedProviders: ['modal', 'docker'],
      });
      expect(txInsert).toHaveBeenCalledWith(expect.anything());
    });

    it('enables Docker without dropping other exclusions', async () => {
      const txInsert = createInsertChain();

      mockDbTransaction.mockImplementation(async (callback) =>
        callback({
          select: createSelectChain([
            {
              runtimeComputeConfig: {
                defaultProvider: 'e2b',
                excludedProviders: ['docker', 'modal'],
              },
            },
          ]),
          insert: txInsert,
        } as never),
      );

      const result = await setLocalDockerEnabledCommand(buildMockAuth(), {
        enabled: true,
      });

      expect(result.runtimeComputeConfig).toEqual({
        defaultProvider: 'e2b',
        excludedProviders: ['modal'],
      });
    });
  });
});
