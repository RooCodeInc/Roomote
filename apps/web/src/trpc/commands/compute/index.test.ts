import type { FeatureFlag } from '@roomote/feature-flags';

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
}));

vi.mock('./compute-provisioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./compute-provisioning')>();

  return {
    ...actual,
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
  clearComputeWorkerImageCommand,
  getComputeStatusCommand,
  saveComputeConfigCommand,
  saveComputeWorkerImageCommand,
  setDefaultComputeProviderCommand,
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
    featureFlags: {} as Record<FeatureFlag, boolean>,
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
    'E2B_API_KEY',
    'E2B_TEMPLATE_ID',
    'E2B_DOMAIN',
    'DAYTONA_API_KEY',
    'DAYTONA_SNAPSHOT_NAME',
    'DAYTONA_API_URL',
    'DAYTONA_TARGET',
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

    it('persists submitted credential and infrastructure values together', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'e2b',
        values: {
          E2B_API_KEY: 'e2b-key',
          E2B_TEMPLATE_ID: 'manual-template',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'compute-test-user',
          values: [
            { name: 'E2B_API_KEY', value: 'e2b-key' },
            { name: 'E2B_TEMPLATE_ID', value: 'manual-template' },
          ],
        }),
      );
      // A manual artifact value skips auto-provisioning.
      expect(mockRunComputeProvisioning).not.toHaveBeenCalled();
    });

    it('persists a submitted shared worker image', async () => {
      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'modal',
        values: {
          MODAL_TOKEN_ID: 'token-id',
          MODAL_TOKEN_SECRET: 'token-secret',
          DOCKER_WORKER_IMAGE: 'registry.example.com/worker:tag',
        },
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          values: expect.arrayContaining([
            {
              name: 'DOCKER_WORKER_IMAGE',
              value: 'registry.example.com/worker:tag',
            },
            {
              name: 'MODAL_BASE_IMAGE_REF',
              value: 'registry.example.com/worker:tag',
            },
          ]),
        }),
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
        templateRef: 'roomote-worker:tag',
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
        templateRef: 'roomote-worker-tag',
      });
    });

    it('starts the E2B template build from a saved worker image', async () => {
      mockResolveSavedWorkerImage.mockResolvedValue(
        'registry.example.com/worker:tag',
      );

      await saveComputeConfigCommand(buildMockAuth(), {
        provider: 'e2b',
        values: { E2B_API_KEY: 'e2b-key' },
      });

      expect(mockRunComputeProvisioning).toHaveBeenCalledWith({
        provider: 'e2b',
        userId: 'compute-test-user',
        imageRef: 'registry.example.com/worker:tag',
        templateRef: 'roomote-worker:tag',
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

    it('is a no-op for providers without credential fields', async () => {
      await clearComputeConfigCommand(buildMockAuth(), { provider: 'docker' });

      expect(mockDbTransaction).not.toHaveBeenCalled();
    });
  });

  describe('saveComputeWorkerImageCommand', () => {
    beforeEach(() => {
      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          insert: createInsertChain(),
        } as never);
      });
      delete process.env.DOCKER_WORKER_IMAGE;
    });

    afterEach(() => {
      delete process.env.DOCKER_WORKER_IMAGE;
    });

    it('saves the shared worker image as a deployment env var', async () => {
      await saveComputeWorkerImageCommand(buildMockAuth(), {
        value: '  registry.example.com/worker:tag  ',
      });

      expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'compute-test-user',
          values: [
            {
              name: 'DOCKER_WORKER_IMAGE',
              value: 'registry.example.com/worker:tag',
            },
          ],
        }),
      );
    });

    it('rejects a blank worker image', async () => {
      await expect(
        saveComputeWorkerImageCommand(buildMockAuth(), { value: '   ' }),
      ).rejects.toThrow('Enter a worker image reference to save.');
    });

    it('refuses to override an env-provided worker image', async () => {
      process.env.DOCKER_WORKER_IMAGE = 'registry.example.com/env:tag';

      await expect(
        saveComputeWorkerImageCommand(buildMockAuth(), {
          value: 'registry.example.com/worker:tag',
        }),
      ).rejects.toThrow(
        'The worker image is set via an environment variable and cannot be overridden here.',
      );
    });
  });

  describe('clearComputeWorkerImageCommand', () => {
    it('deletes the shared worker image deployment env var', async () => {
      const txWhere = vi.fn(async () => undefined);
      const txDelete = vi.fn(() => ({ where: txWhere }));
      const { inArray: txInArray } = await import('@roomote/db/server');

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({ delete: txDelete } as never);
      });

      await clearComputeWorkerImageCommand(buildMockAuth());

      expect(txInArray).toHaveBeenCalledWith('env.name', [
        'DOCKER_WORKER_IMAGE',
      ]);
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
        'Configure Modal before making it the default compute provider.',
      );
    });

    it('persists the default for a configured provider', async () => {
      const txInsert = createInsertChain();

      mockDbTransaction.mockImplementation(async (callback) => {
        return callback({
          select: createSelectChain(),
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

      expect(result.runtimeComputeConfig).toEqual({ defaultProvider: 'e2b' });
      expect(txInsert).toHaveBeenCalledWith(expect.anything());
    });
  });
});
