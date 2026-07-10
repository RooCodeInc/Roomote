// pnpm --filter @roomote/controller test src/__tests__/utils.test.ts

import {
  type EnvironmentConfig,
  SANDBOX_SERVER_NAMED_PORT,
} from '@roomote/types';
import { db } from '@roomote/db/server';

import {
  getNamedPortsForTaskRun,
  shouldEnableAuthBypassForTaskRun,
  updateTaskRunMachine,
} from '../utils';

const originalTrpcUrl = process.env.TRPC_URL;
const originalRoomoteAppUrl = process.env.ROOMOTE_APP_URL;
const originalPreviewProxyBaseUrl = process.env.PREVIEW_PROXY_BASE_URL;
const originalPreviewDomains = process.env.PREVIEW_DOMAINS;
const originalRoomotePreviewDomain = process.env.ROOMOTE_PREVIEW_DOMAIN;

const mockUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});
const mockDeploymentSettingsFindFirst = vi.fn();
const mockResolveEffectivePreviewRuntimeConfig = vi.fn(
  async (_params?: unknown) => ({
    analysis: {
      isReady: true,
    },
  }),
);
type MockEnvironmentSnapshot = {
  provider: 'modal';
  snapshotId: string | null;
  snapshotStatus: string | null;
  snapshotCreatedAt: Date | null;
  snapshotExpiresAt: Date | null;
};

const mockGetEnvironmentSnapshot = vi.fn<
  (params: {
    environmentId: string;
    provider: string;
  }) => Promise<MockEnvironmentSnapshot | undefined>
>(async () => undefined);

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn() },
      deploymentSettings: {
        findFirst: (...args: unknown[]) =>
          mockDeploymentSettingsFindFirst(...args),
      },
    },
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  taskRuns: { id: 'id' },
  environments: {},
  deploymentSettings: {},
  eq: vi.fn(),
  getEnvironmentSnapshot: (
    params: Parameters<typeof mockGetEnvironmentSnapshot>[0],
  ) => mockGetEnvironmentSnapshot(params),
  resolveEffectivePreviewRuntimeConfig: (params: unknown) =>
    mockResolveEffectivePreviewRuntimeConfig(params),
}));

function mockEnvironmentConfig(
  overrides: Partial<EnvironmentConfig> = {},
): EnvironmentConfig {
  return {
    name: 'Test Environment',
    repositories: [{ repository: 'test/repo' }],
    ...overrides,
  };
}

describe('getNamedPortsForTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      metadata: {},
    });
    mockResolveEffectivePreviewRuntimeConfig.mockResolvedValue({
      analysis: {
        isReady: true,
      },
    });
    delete process.env.TRPC_URL;
    delete process.env.ROOMOTE_APP_URL;
    process.env.PREVIEW_PROXY_BASE_URL = 'https://preview.roomote.test';
    process.env.PREVIEW_DOMAINS = 'preview.roomote.test';
    delete process.env.ROOMOTE_PREVIEW_DOMAIN;
  });

  afterAll(() => {
    if (originalTrpcUrl === undefined) {
      delete process.env.TRPC_URL;
    } else {
      process.env.TRPC_URL = originalTrpcUrl;
    }

    if (originalRoomoteAppUrl === undefined) {
      delete process.env.ROOMOTE_APP_URL;
    } else {
      process.env.ROOMOTE_APP_URL = originalRoomoteAppUrl;
    }

    if (originalPreviewProxyBaseUrl === undefined) {
      delete process.env.PREVIEW_PROXY_BASE_URL;
    } else {
      process.env.PREVIEW_PROXY_BASE_URL = originalPreviewProxyBaseUrl;
    }

    if (originalPreviewDomains === undefined) {
      delete process.env.PREVIEW_DOMAINS;
    } else {
      process.env.PREVIEW_DOMAINS = originalPreviewDomains;
    }

    if (originalRoomotePreviewDomain === undefined) {
      delete process.env.ROOMOTE_PREVIEW_DOMAIN;
    } else {
      process.env.ROOMOTE_PREVIEW_DOMAIN = originalRoomotePreviewDomain;
    }
  });

  it('includes the sandbox server system port for environment jobs', async () => {
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: 'env-123',
      config: mockEnvironmentConfig(),
      snapshotId: null,
      snapshotStatus: null,
      snapshotExpiresAt: null,
    } as unknown as Awaited<
      ReturnType<typeof db.query.environments.findFirst>
    >);

    const taskRun = {
      id: 123,
      payload: { environmentId: 'env-123' },
    } as Parameters<typeof getNamedPortsForTaskRun>[0];

    const result = await getNamedPortsForTaskRun(taskRun);

    expect(result.namedPorts).toContainEqual(SANDBOX_SERVER_NAMED_PORT);
  });

  it('exposes configured preview ports', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValueOnce({
      metadata: {
        previews_enabled: true,
      },
    });
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: 'env-123',
      config: mockEnvironmentConfig({
        ports: [{ name: 'WEB', port: 3000 }],
      }),
      snapshotId: null,
      snapshotStatus: null,
      snapshotExpiresAt: null,
    } as unknown as Awaited<
      ReturnType<typeof db.query.environments.findFirst>
    >);

    const taskRun = {
      id: 123,
      payload: { environmentId: 'env-123' },
    } as Parameters<typeof getNamedPortsForTaskRun>[0];

    const result = await getNamedPortsForTaskRun(taskRun);

    expect(result.namedPorts).toEqual([
      SANDBOX_SERVER_NAMED_PORT,
      { name: 'WEB', port: 3000 },
    ]);
    expect(result.environmentConfig?.ports).toEqual([
      { name: 'WEB', port: 3000 },
    ]);
  });

  it('does not expose configured preview ports when deployment previews are disabled', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValueOnce({
      metadata: {
        previews_enabled: false,
      },
    });
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: 'env-123',
      config: mockEnvironmentConfig({
        ports: [{ name: 'WEB', port: 3000 }],
      }),
      snapshotId: null,
      snapshotStatus: null,
      snapshotExpiresAt: null,
    } as unknown as Awaited<
      ReturnType<typeof db.query.environments.findFirst>
    >);

    const taskRun = {
      id: 123,
      payload: { environmentId: 'env-123' },
    } as Parameters<typeof getNamedPortsForTaskRun>[0];

    const result = await getNamedPortsForTaskRun(taskRun);

    expect(result.namedPorts).toEqual([SANDBOX_SERVER_NAMED_PORT]);
    expect(result.environmentConfig?.ports).toEqual([
      { name: 'WEB', port: 3000 },
    ]);
  });

  it('does not expose configured preview ports when the environment disables previews', async () => {
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: 'env-123',
      config: mockEnvironmentConfig({
        previews_enabled: false,
        ports: [{ name: 'WEB', port: 3000 }],
      }),
      snapshotId: null,
      snapshotStatus: null,
      snapshotExpiresAt: null,
    } as unknown as Awaited<
      ReturnType<typeof db.query.environments.findFirst>
    >);

    const taskRun = {
      id: 123,
      payload: { environmentId: 'env-123' },
    } as Parameters<typeof getNamedPortsForTaskRun>[0];

    const result = await getNamedPortsForTaskRun(taskRun);

    expect(result.namedPorts).toEqual([SANDBOX_SERVER_NAMED_PORT]);
    expect(result.environmentConfig?.ports).toEqual([
      { name: 'WEB', port: 3000 },
    ]);
    expect(result.environmentConfig?.previews_enabled).toBe(false);
  });

  it('does not expose callback ports from loopback controller URLs', async () => {
    process.env.TRPC_URL = 'http://127.0.0.1:3001';
    process.env.ROOMOTE_APP_URL = 'http://localhost:3000';
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: 'env-123',
      config: mockEnvironmentConfig(),
      snapshotId: null,
      snapshotStatus: null,
      snapshotExpiresAt: null,
    } as unknown as Awaited<
      ReturnType<typeof db.query.environments.findFirst>
    >);

    const taskRun = {
      id: 123,
      payload: { environmentId: 'env-123' },
    } as Parameters<typeof getNamedPortsForTaskRun>[0];

    const result = await getNamedPortsForTaskRun(taskRun);

    expect(result.namedPorts).toEqual([SANDBOX_SERVER_NAMED_PORT]);
  });

  describe('environment snapshots', () => {
    it('should return environmentSnapshotId when snapshot is ready and not expired', async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      vi.mocked(db.query.environments.findFirst).mockResolvedValue({
        id: 'env-123',
        config: mockEnvironmentConfig(),
      } as unknown as Awaited<
        ReturnType<typeof db.query.environments.findFirst>
      >);
      mockGetEnvironmentSnapshot.mockResolvedValue({
        provider: 'modal',
        snapshotId: 'snapshot-456',
        snapshotStatus: 'ready',
        snapshotCreatedAt: null,
        snapshotExpiresAt: futureDate,
      });

      const taskRun = {
        id: 123,
        payload: {
          environmentId: 'env-123',
        },
      } as Parameters<typeof getNamedPortsForTaskRun>[0];

      const result = await getNamedPortsForTaskRun(taskRun);

      expect(result.environmentSnapshotId).toBe('snapshot-456');
    });

    it('should not return environmentSnapshotId when snapshot is expired', async () => {
      const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      vi.mocked(db.query.environments.findFirst).mockResolvedValue({
        id: 'env-123',
        config: mockEnvironmentConfig(),
      } as unknown as Awaited<
        ReturnType<typeof db.query.environments.findFirst>
      >);
      mockGetEnvironmentSnapshot.mockResolvedValue({
        provider: 'modal',
        snapshotId: 'snapshot-456',
        snapshotStatus: 'ready',
        snapshotCreatedAt: null,
        snapshotExpiresAt: pastDate,
      });

      const taskRun = {
        id: 123,
        payload: {
          environmentId: 'env-123',
        },
      } as Parameters<typeof getNamedPortsForTaskRun>[0];

      const result = await getNamedPortsForTaskRun(taskRun);

      expect(result.environmentSnapshotId).toBeUndefined();
    });

    it('should not return environmentSnapshotId when snapshot status is not ready', async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);

      vi.mocked(db.query.environments.findFirst).mockResolvedValue({
        id: 'env-123',
        config: mockEnvironmentConfig(),
      } as unknown as Awaited<
        ReturnType<typeof db.query.environments.findFirst>
      >);
      mockGetEnvironmentSnapshot.mockResolvedValue({
        provider: 'modal',
        snapshotId: 'snapshot-456',
        snapshotStatus: 'pending',
        snapshotCreatedAt: null,
        snapshotExpiresAt: futureDate,
      });

      const taskRun = {
        id: 123,
        payload: { environmentId: 'env-123' },
      } as Parameters<typeof getNamedPortsForTaskRun>[0];

      const result = await getNamedPortsForTaskRun(taskRun);

      expect(result.environmentSnapshotId).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle environment not found in database', async () => {
      vi.mocked(db.query.environments.findFirst).mockResolvedValue(undefined);

      const taskRun = {
        id: 123,
        payload: {
          environmentId: 'non-existent-env',
        },
      } as Parameters<typeof getNamedPortsForTaskRun>[0];

      const result = await getNamedPortsForTaskRun(taskRun);

      // Should still include base ports even if environment not found
      expect(result.namedPorts).toContainEqual(SANDBOX_SERVER_NAMED_PORT);
      expect(result.namedPorts).toHaveLength(1);
      expect(result.environmentSnapshotId).toBeUndefined();
    });
  });
});

describe('shouldEnableAuthBypassForTaskRun', () => {
  it('does not generate a bypass without an environment config', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        namedPorts: [SANDBOX_SERVER_NAMED_PORT],
      }),
    ).toBe(false);
  });

  it('honors an explicit auth bypass disable', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig({
          auth_bypass_header: false,
          ports: [{ name: 'WEB', port: 3000 }],
        }),
        namedPorts: [SANDBOX_SERVER_NAMED_PORT, { name: 'WEB', port: 3000 }],
      }),
    ).toBe(false);
  });

  it('does not generate a bypass for the sandbox server alone', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig(),
        namedPorts: [SANDBOX_SERVER_NAMED_PORT],
      }),
    ).toBe(false);
  });

  it('does not generate a bypass for configured ports that are not exposed', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig({
          ports: [{ name: 'WEB', port: 3000 }],
        }),
        namedPorts: [SANDBOX_SERVER_NAMED_PORT],
      }),
    ).toBe(false);
  });

  it('generates a bypass for exposed authenticated proxied preview ports', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig({
          ports: [{ name: 'WEB', port: 3000 }],
        }),
        namedPorts: [SANDBOX_SERVER_NAMED_PORT, { name: 'WEB', port: 3000 }],
      }),
    ).toBe(true);
  });

  it('does not generate a bypass for unauthenticated preview ports', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig({
          ports: [{ name: 'WEB', port: 3000, unauthenticated: true }],
        }),
        namedPorts: [
          SANDBOX_SERVER_NAMED_PORT,
          { name: 'WEB', port: 3000, unauthenticated: true },
        ],
      }),
    ).toBe(false);
  });

  it('does not generate a bypass for ordinary unproxied preview ports', () => {
    expect(
      shouldEnableAuthBypassForTaskRun({
        environmentConfig: mockEnvironmentConfig({
          ports: [{ name: 'WEB', port: 3000, proxied: false }],
        }),
        namedPorts: [
          SANDBOX_SERVER_NAMED_PORT,
          { name: 'WEB', port: 3000, proxied: false },
        ],
      }),
    ).toBe(false);
  });
});

describe('updateTaskRunMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores routing info for the explicit primary port', async () => {
    const taskRun = {
      id: 1,
      sourceSnapshotId: null,
    } as Parameters<typeof updateTaskRunMachine>[0]['taskRun'];

    await updateTaskRunMachine({
      taskRun,
      machineId: 'machine-1',
      machineDomains: {
        SANDBOX_SERVER: 'https://sandbox.localhost',
        WEB: 'https://web.localhost',
      },
      explicitPrimaryPortName: 'WEB',
    });

    const setCall = mockUpdate.mock.results[0]?.value.set;
    const setArg = setCall.mock.calls[0][0];

    expect(setArg.machineDomain).toBe('https://web.localhost');
    expect(setArg.primaryPortName).toBe('WEB');
    expect(setArg.sandboxServerUrl).toBe('https://sandbox.localhost');
  });

  it('stores provision-time compute resource snapshots when provided', async () => {
    const taskRun = {
      id: 1,
      sourceSnapshotId: null,
    } as Parameters<typeof updateTaskRunMachine>[0]['taskRun'];

    await updateTaskRunMachine({
      taskRun,
      machineId: 'machine-1',
      machineDomains: {
        SANDBOX_SERVER: 'https://sandbox.localhost',
      },
      configuredVcpus: 8,
      configuredCpuCores: null,
      configuredMemoryMiB: 16384,
    });

    const setCall = mockUpdate.mock.results[0]?.value.set;
    const setArg = setCall.mock.calls[0][0];

    expect(setArg.configuredVcpus).toBe(8);
    expect(setArg.configuredCpuCores).toBeNull();
    expect(setArg.configuredMemoryMiB).toBe(16384);
  });

  it('clears a stale source snapshot id when the machine booted fresh', async () => {
    const taskRun = {
      id: 1,
      sourceSnapshotId: 'snap_stale_123',
    } as Parameters<typeof updateTaskRunMachine>[0]['taskRun'];

    await updateTaskRunMachine({
      taskRun,
      machineId: 'machine-1',
      machineDomains: {
        SANDBOX_SERVER: 'https://sandbox.localhost',
      },
      sourceSnapshotId: null,
    });

    const setCall = mockUpdate.mock.results[0]?.value.set;
    const setArg = setCall.mock.calls[0][0];

    expect(setArg.sourceSnapshotId).toBeNull();
  });
});
