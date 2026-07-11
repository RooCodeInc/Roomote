import type { TaskRun } from '@roomote/db/server';

const {
  mockEnv,
  mockFindOrg,
  mockSpawnDaytonaWorker,
  mockSpawnDockerWorker,
  mockSpawnE2bWorker,
  mockSpawnModalWorker,
  mockSpawnBlaxelWorker,
} = vi.hoisted(() => ({
  mockEnv: {
    MODAL_TOKEN_ID: 'modal-token-id',
    MODAL_TOKEN_SECRET: 'modal-token-secret',
    MODAL_ENDPOINT: undefined,
    MODAL_ENVIRONMENT: undefined,
    MODAL_APP_NAME: undefined,
    MODAL_BASE_IMAGE_REF: 'ghcr.io/roomote/modal-worker:test',
    MODAL_REGISTRY_USERNAME: undefined,
    MODAL_REGISTRY_PASSWORD: undefined,
    MODAL_ECR_OIDC_ROLE_ARN: undefined,
    MODAL_ECR_REGION: undefined,
    MODAL_REGIONS: undefined,
    TRPC_URL: 'http://localhost:13001',
    DOCKER_WORKER_IMAGE: 'roomote-worker:local',
    DOCKER_WORKER_PLATFORM: 'linux/amd64',
    DOCKER_WORKER_NETWORK: undefined,
    DOCKER_WORKER_RELEASE_PATH: undefined,
    DOCKER_WORKER_CPU_LIMIT: 2,
    DOCKER_WORKER_MEMORY_LIMIT: '4g',
    DOCKER_WORKER_PIDS_LIMIT: 512,
    DOCKER_WORKER_DISK_LIMIT: '20g',
    DOCKER_WORKER_ALLOW_UNBOUNDED_DISK: false,
    DOCKER_WORKER_LOG_MAX_SIZE: '10m',
    DOCKER_WORKER_LOG_MAX_FILES: 3,
    DOCKER_WORKER_EGRESS_POLICY: 'internet',
    DAYTONA_API_KEY: 'daytona-key',
    DAYTONA_API_URL: undefined,
    DAYTONA_TARGET: undefined,
    DAYTONA_SNAPSHOT_NAME: 'roomote-worker',
    E2B_API_KEY: 'e2b-key',
    E2B_DOMAIN: undefined,
    E2B_TEMPLATE_ID: 'roomote-worker-template',
    E2B_MAX_SANDBOX_TIMEOUT_MS: 3_600_000,
    BL_API_KEY: 'blaxel-key',
    BL_WORKSPACE: 'roomote',
    BLAXEL_IMAGE: 'ghcr.io/roomote/worker:test',
    BLAXEL_REGION: 'us-pdx-1',
  } as Record<string, string | number | boolean | undefined>,
  mockFindOrg: vi.fn(),
  mockSpawnDaytonaWorker: vi.fn(),
  mockSpawnDockerWorker: vi.fn(),
  mockSpawnE2bWorker: vi.fn(),
  mockSpawnModalWorker: vi.fn(),
  mockSpawnBlaxelWorker: vi.fn(),
}));

const { mockFinishRun } = vi.hoisted(() => ({
  mockFinishRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: mockEnv,
  };
});

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      query: {
        ...actual.db.query,
        orgs: {
          findFirst: (...args: unknown[]) => mockFindOrg(...args),
        },
      },
    },
  };
});

vi.mock('@roomote/sdk/server', () => ({
  finishRun: (...args: unknown[]) => mockFinishRun(...args),
}));

vi.mock('../compute-providers', () => ({
  cleanupStaleDockerSandboxes: vi.fn().mockResolvedValue(undefined),
  spawnDaytonaWorker: (...args: unknown[]) => mockSpawnDaytonaWorker(...args),
  spawnDockerWorker: (...args: unknown[]) => mockSpawnDockerWorker(...args),
  spawnE2bWorker: (...args: unknown[]) => mockSpawnE2bWorker(...args),
  spawnModalWorker: (...args: unknown[]) => mockSpawnModalWorker(...args),
  spawnBlaxelWorker: (...args: unknown[]) => mockSpawnBlaxelWorker(...args),
}));

import { RoomoteController } from '../RoomoteController';

describe('RoomoteController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrg.mockResolvedValue({ slug: 'roomote', name: 'Roomote' });
    mockEnv.MODAL_TOKEN_ID = 'modal-token-id';
    mockEnv.MODAL_TOKEN_SECRET = 'modal-token-secret';
    mockEnv.MODAL_BASE_IMAGE_REF = 'ghcr.io/roomote/modal-worker:test';
    mockEnv.MODAL_REGISTRY_USERNAME = undefined;
    mockEnv.MODAL_REGISTRY_PASSWORD = undefined;
    mockEnv.MODAL_ECR_OIDC_ROLE_ARN = undefined;
    mockEnv.MODAL_ECR_REGION = undefined;
    mockEnv.MODAL_REGIONS = undefined;
    mockEnv.TRPC_URL = 'http://localhost:13001';
    mockEnv.DOCKER_WORKER_IMAGE = 'roomote-worker:local';
    mockEnv.DOCKER_WORKER_PLATFORM = 'linux/amd64';
    mockEnv.DOCKER_WORKER_NETWORK = undefined;
    mockEnv.DOCKER_WORKER_RELEASE_PATH = undefined;
    mockEnv.DOCKER_WORKER_CPU_LIMIT = 2;
    mockEnv.DOCKER_WORKER_MEMORY_LIMIT = '4g';
    mockEnv.DOCKER_WORKER_PIDS_LIMIT = 512;
    mockEnv.DOCKER_WORKER_DISK_LIMIT = '20g';
    mockEnv.DOCKER_WORKER_ALLOW_UNBOUNDED_DISK = false;
    mockEnv.DOCKER_WORKER_LOG_MAX_SIZE = '10m';
    mockEnv.DOCKER_WORKER_LOG_MAX_FILES = 3;
    mockEnv.DOCKER_WORKER_EGRESS_POLICY = 'internet';
    mockEnv.DAYTONA_API_KEY = 'daytona-key';
    mockEnv.DAYTONA_API_URL = undefined;
    mockEnv.DAYTONA_TARGET = undefined;
    mockEnv.DAYTONA_SNAPSHOT_NAME = 'roomote-worker';
    mockEnv.E2B_API_KEY = 'e2b-key';
    mockEnv.E2B_DOMAIN = undefined;
    mockEnv.E2B_TEMPLATE_ID = 'roomote-worker-template';
    mockEnv.E2B_MAX_SANDBOX_TIMEOUT_MS = 3_600_000;
    mockEnv.BL_API_KEY = 'blaxel-key';
    mockEnv.BL_WORKSPACE = 'roomote';
    mockEnv.BLAXEL_IMAGE = 'ghcr.io/roomote/worker:test';
    mockEnv.BLAXEL_REGION = 'us-pdx-1';
    mockSpawnDockerWorker.mockResolvedValue({ containerId: 'worker-47' });
  });

  it('does not require hosted compute credentials during local construction', async () => {
    mockEnv.MODAL_BASE_IMAGE_REF = undefined;

    expect(() => new RoomoteController('development')).not.toThrow();
  });

  it('spawns Docker workers when Docker is the selected provider', async () => {
    mockEnv.DOCKER_WORKER_NETWORK = 'roomote_default';
    const controller = new RoomoteController('production');

    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'docker',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      {
        id: 48,
        payload: { environmentId: 'env_123' },
      } as TaskRun,
      'auth-token',
      'roomote',
      60_000,
      'docker',
    );

    expect(mockSpawnDockerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 48 }),
      'auth-token',
      expect.objectContaining({
        image: 'roomote-worker:local',
        platform: 'linux/amd64',
        network: 'roomote_default',
        dockerTimeoutMs: 60_000,
        cpuLimit: 2,
        memoryLimit: '4g',
        pidsLimit: 512,
        diskLimit: '20g',
        allowUnboundedDisk: false,
        logMaxSize: '10m',
        logMaxFiles: 3,
        egressPolicy: 'internet',
      }),
    );
  });

  it('requires Modal credentials only when spawning a Modal worker', async () => {
    mockEnv.MODAL_BASE_IMAGE_REF = undefined;
    const controller = new RoomoteController('development');

    await expect(
      (
        controller as unknown as {
          spawnFreshWorker: (
            taskRun: TaskRun,
            authToken: string,
            deploymentSlug: string,
            timeoutMs: number,
            provider: 'modal',
          ) => Promise<void>;
        }
      ).spawnFreshWorker(
        {
          id: 46,
          payload: { environmentId: 'env_123' },
        } as TaskRun,
        'auth-token',
        'roomote',
        60_000,
        'modal',
      ),
    ).rejects.toThrow(
      'MODAL_BASE_IMAGE_REF is required to spawn Modal workers',
    );
  });

  it('spawns Daytona workers when Daytona is the selected provider', async () => {
    const controller = new RoomoteController('production');

    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'daytona',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      {
        id: 49,
        payload: { environmentId: 'env_123' },
      } as TaskRun,
      'auth-token',
      'roomote',
      60_000,
      'daytona',
    );

    expect(mockSpawnDaytonaWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 49 }),
      'auth-token',
      expect.objectContaining({
        daytonaApiKey: 'daytona-key',
        daytonaSnapshotName: 'roomote-worker',
        daytonaTimeoutMs: 60_000,
        deploymentSlug: 'roomote',
        daytonaTags: {
          app_environment: 'production',
        },
      }),
    );
  });

  it('requires Daytona credentials only when spawning a Daytona worker', async () => {
    mockEnv.DAYTONA_API_KEY = undefined;
    const controller = new RoomoteController('development');

    await expect(
      (
        controller as unknown as {
          spawnFreshWorker: (
            taskRun: TaskRun,
            authToken: string,
            deploymentSlug: string,
            timeoutMs: number,
            provider: 'daytona',
          ) => Promise<void>;
        }
      ).spawnFreshWorker(
        {
          id: 50,
          payload: { environmentId: 'env_123' },
        } as TaskRun,
        'auth-token',
        'roomote',
        60_000,
        'daytona',
      ),
    ).rejects.toThrow('DAYTONA_API_KEY is required to spawn Daytona workers');

    expect(mockSpawnDaytonaWorker).not.toHaveBeenCalled();
  });

  it('spawns E2B workers when E2B is the selected provider', async () => {
    const controller = new RoomoteController('production');

    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'e2b',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      {
        id: 51,
        payload: { environmentId: 'env_123' },
      } as TaskRun,
      'auth-token',
      'roomote',
      60_000,
      'e2b',
    );

    expect(mockSpawnE2bWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 51 }),
      'auth-token',
      expect.objectContaining({
        e2bApiKey: 'e2b-key',
        e2bTemplateId: 'roomote-worker-template',
        e2bTimeoutMs: 60_000,
        deploymentSlug: 'roomote',
        e2bTags: {
          app_environment: 'production',
        },
      }),
    );
  });

  it('clamps the E2B sandbox timeout to the configured plan ceiling', async () => {
    const controller = new RoomoteController('production');

    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'e2b',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      {
        id: 53,
        payload: { environmentId: 'env_123' },
      } as TaskRun,
      'auth-token',
      'roomote',
      5 * 60 * 60 * 1_000,
      'e2b',
    );

    expect(mockSpawnE2bWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 53 }),
      'auth-token',
      expect.objectContaining({
        e2bTimeoutMs: 3_600_000,
      }),
    );
  });

  it('requires E2B credentials only when spawning an E2B worker', async () => {
    mockEnv.E2B_API_KEY = undefined;
    const controller = new RoomoteController('development');

    await expect(
      (
        controller as unknown as {
          spawnFreshWorker: (
            taskRun: TaskRun,
            authToken: string,
            deploymentSlug: string,
            timeoutMs: number,
            provider: 'e2b',
          ) => Promise<void>;
        }
      ).spawnFreshWorker(
        {
          id: 52,
          payload: { environmentId: 'env_123' },
        } as TaskRun,
        'auth-token',
        'roomote',
        60_000,
        'e2b',
      ),
    ).rejects.toThrow('E2B_API_KEY is required to spawn E2B workers');

    expect(mockSpawnE2bWorker).not.toHaveBeenCalled();
  });

  it('spawns Blaxel workers when Blaxel is selected', async () => {
    const controller = new RoomoteController('production');
    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'blaxel',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      { id: 54, payload: { environmentId: 'env_123' } } as TaskRun,
      'auth-token',
      'roomote',
      60_000,
      'blaxel',
    );

    expect(mockSpawnBlaxelWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 54 }),
      'auth-token',
      expect.objectContaining({
        blaxelApiKey: 'blaxel-key',
        blaxelWorkspace: 'roomote',
        blaxelImage: 'ghcr.io/roomote/worker:test',
        blaxelRegion: 'us-pdx-1',
        blaxelTimeoutMs: 60_000,
        deploymentSlug: 'roomote',
      }),
    );
  });

  it('rejects partial Modal private registry config on startup', () => {
    mockEnv.MODAL_REGISTRY_USERNAME = 'ghcr-user';
    mockEnv.MODAL_REGISTRY_PASSWORD = undefined;

    expect(() => new RoomoteController('preview')).toThrow(
      'Modal registry auth config is partial; set MODAL_REGISTRY_USERNAME and MODAL_REGISTRY_PASSWORD together',
    );
  });

  it('adds deployment tags when spawning a modal worker', async () => {
    mockEnv.MODAL_REGISTRY_USERNAME = 'ghcr-user';
    mockEnv.MODAL_REGISTRY_PASSWORD = 'ghcr-token';
    mockEnv.MODAL_REGIONS = 'us,us-west';
    const controller = new RoomoteController('preview');

    await (
      controller as unknown as {
        spawnFreshWorker: (
          taskRun: TaskRun,
          authToken: string,
          deploymentSlug: string,
          timeoutMs: number,
          provider: 'modal',
        ) => Promise<void>;
      }
    ).spawnFreshWorker(
      {
        id: 44,
        payload: { environmentId: 'env_123' },
      } as TaskRun,
      'auth-token',
      'roomote',
      60_000,
      'modal',
    );

    expect(mockSpawnModalWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 44 }),
      'auth-token',
      expect.objectContaining({
        deploymentSlug: 'roomote',
        modalTags: {
          app_environment: 'preview',
        },
        modalTokenId: 'modal-token-id',
        modalTokenSecret: 'modal-token-secret',
        modalBaseImageRef: 'ghcr.io/roomote/modal-worker:test',
        modalRegistryUsername: 'ghcr-user',
        modalRegistryPassword: 'ghcr-token',
        modalRegions: 'us,us-west',
      }),
    );
  });
});
