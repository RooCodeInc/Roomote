import { createComputeProviderClient } from '../factory';
import type { DaytonaConfig, E2bConfig, ModalConfig } from '../types';

const {
  modalClientMock,
  dockerClientMock,
  daytonaClientMock,
  e2bClientMock,
  dockerCapabilities,
  daytonaCapabilities,
  e2bCapabilities,
  modalCapabilities,
} = vi.hoisted(() => ({
  modalClientMock: vi.fn(),
  dockerClientMock: vi.fn(),
  daytonaClientMock: vi.fn(),
  e2bClientMock: vi.fn(),
  dockerCapabilities: {
    snapshots: false,
    detachedCommands: false,
    partialSnapshots: false,
  },
  daytonaCapabilities: {
    snapshots: false,
    detachedCommands: true,
    partialSnapshots: false,
  },
  e2bCapabilities: {
    snapshots: true,
    detachedCommands: true,
    partialSnapshots: false,
  },
  modalCapabilities: {
    snapshots: true,
    detachedCommands: true,
    partialSnapshots: false,
  },
}));

vi.mock('../adapters', () => ({
  DockerClient: dockerClientMock,
  ModalClient: modalClientMock,
  DaytonaClient: daytonaClientMock,
  E2bClient: e2bClientMock,
  DOCKER_CAPABILITIES: dockerCapabilities,
  DAYTONA_CAPABILITIES: daytonaCapabilities,
  E2B_CAPABILITIES: e2bCapabilities,
  MODAL_CAPABILITIES: modalCapabilities,
}));

describe('createComputeProviderClient', () => {
  const originalModalRegistryUsername = process.env.MODAL_REGISTRY_USERNAME;
  const originalModalRegistryPassword = process.env.MODAL_REGISTRY_PASSWORD;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MODAL_REGISTRY_USERNAME;
    delete process.env.MODAL_REGISTRY_PASSWORD;
  });

  afterAll(() => {
    if (originalModalRegistryUsername === undefined) {
      delete process.env.MODAL_REGISTRY_USERNAME;
    } else {
      process.env.MODAL_REGISTRY_USERNAME = originalModalRegistryUsername;
    }

    if (originalModalRegistryPassword === undefined) {
      delete process.env.MODAL_REGISTRY_PASSWORD;
    } else {
      process.env.MODAL_REGISTRY_PASSWORD = originalModalRegistryPassword;
    }
  });

  it('applies low Modal requests while enforcing shared sandbox caps by default', () => {
    createComputeProviderClient({
      provider: 'modal',
      config: {
        tokenId: 'token-id',
        tokenSecret: 'token-secret',
        baseImageRef: 'ghcr.io/roomote/modal-worker:test',
      },
    });

    expect(modalClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 'token-id',
        tokenSecret: 'token-secret',
        baseImageRef: 'ghcr.io/roomote/modal-worker:test',
        cpu: 0.125,
        cpuLimit: 8,
        memoryMiB: 128,
        memoryLimitMiB: 32_768,
      }),
    );
  });

  it('resolves Modal private registry credentials from env', () => {
    process.env.MODAL_REGISTRY_USERNAME = 'ghcr-user';
    process.env.MODAL_REGISTRY_PASSWORD = 'ghcr-token';

    createComputeProviderClient({
      provider: 'modal',
      config: {
        tokenId: 'token-id',
        tokenSecret: 'token-secret',
        baseImageRef: 'ghcr.io/roomote/modal-worker:test',
      },
    });

    expect(modalClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        registryUsername: 'ghcr-user',
        registryPassword: 'ghcr-token',
      }),
    );
  });

  it('falls back to the worker image for a missing Modal base image ref', () => {
    const workerImageEnvKeys = [
      'MODAL_BASE_IMAGE_REF',
      'DOCKER_WORKER_IMAGE',
      'RELEASE_VERSION',
      'ROOMOTE_WORKER_IMAGE_REPO',
      'APP_ENV',
      'NODE_ENV',
    ] as const;
    const originalValues = Object.fromEntries(
      workerImageEnvKeys.map((key) => [key, process.env[key]]),
    );

    for (const key of workerImageEnvKeys) {
      delete process.env[key];
    }

    try {
      createComputeProviderClient({
        provider: 'modal',
        config: {
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
        } as ModalConfig,
        envFallback: {
          DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v9.9.9',
        },
      });

      expect(modalClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseImageRef: 'ghcr.io/roocodeinc/roomote-worker:v9.9.9',
        }),
      );

      createComputeProviderClient({
        provider: 'modal',
        config: {
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
        } as ModalConfig,
        envFallback: { RELEASE_VERSION: 'v1.2.3' },
      });

      expect(modalClientMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseImageRef: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
        }),
      );

      createComputeProviderClient({
        provider: 'modal',
        config: {
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
        } as ModalConfig,
        envFallback: {
          NODE_ENV: 'development',
          DOCKER_WORKER_IMAGE: 'roomote-worker:local',
        },
      });

      expect(modalClientMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseImageRef: 'ghcr.io/roocodeinc/roomote-worker:latest',
        }),
      );

      expect(() =>
        createComputeProviderClient({
          provider: 'modal',
          config: {
            tokenId: 'token-id',
            tokenSecret: 'token-secret',
          } as ModalConfig,
          envFallback: { RELEASE_VERSION: 'self-host-production' },
        }),
      ).toThrow('Missing MODAL_BASE_IMAGE_REF');
    } finally {
      for (const key of workerImageEnvKeys) {
        const originalValue = originalValues[key];

        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  });

  it('creates the Docker client without hosted credentials', () => {
    createComputeProviderClient({ provider: 'docker' });

    expect(dockerClientMock).toHaveBeenCalledWith();
  });

  it('resolves Daytona credentials from env', () => {
    process.env.DAYTONA_API_KEY = 'daytona-key';
    process.env.DAYTONA_SNAPSHOT_NAME = 'roomote-worker';
    process.env.DAYTONA_TARGET = 'us';

    try {
      createComputeProviderClient({ provider: 'daytona' });

      expect(daytonaClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'daytona-key',
          snapshotName: 'roomote-worker',
          target: 'us',
        }),
      );
    } finally {
      delete process.env.DAYTONA_API_KEY;
      delete process.env.DAYTONA_SNAPSHOT_NAME;
      delete process.env.DAYTONA_TARGET;
    }
  });

  it('resolves Modal regions from env as a comma-separated list', () => {
    process.env.MODAL_TOKEN_ID = 'token-id';
    process.env.MODAL_TOKEN_SECRET = 'token-secret';
    process.env.MODAL_BASE_IMAGE_REF = 'ghcr.io/roomote/worker:test';
    process.env.MODAL_REGIONS = ' us-west , us ';

    try {
      createComputeProviderClient({ provider: 'modal' });

      expect(modalClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          regions: ['us-west', 'us'],
        }),
      );
    } finally {
      delete process.env.MODAL_TOKEN_ID;
      delete process.env.MODAL_TOKEN_SECRET;
      delete process.env.MODAL_BASE_IMAGE_REF;
      delete process.env.MODAL_REGIONS;
    }
  });

  it('prefers explicit Modal regions config over MODAL_REGIONS env', () => {
    process.env.MODAL_TOKEN_ID = 'token-id';
    process.env.MODAL_TOKEN_SECRET = 'token-secret';
    process.env.MODAL_BASE_IMAGE_REF = 'ghcr.io/roomote/worker:test';
    process.env.MODAL_REGIONS = 'eu';

    try {
      createComputeProviderClient({
        provider: 'modal',
        config: {
          tokenId: 'token-id',
          tokenSecret: 'token-secret',
          baseImageRef: 'ghcr.io/roomote/worker:test',
          regions: ['us'],
        },
      });

      expect(modalClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          regions: ['us'],
        }),
      );
    } finally {
      delete process.env.MODAL_TOKEN_ID;
      delete process.env.MODAL_TOKEN_SECRET;
      delete process.env.MODAL_BASE_IMAGE_REF;
      delete process.env.MODAL_REGIONS;
    }
  });

  it('requires the Daytona API key and snapshot name', () => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_SNAPSHOT_NAME;

    expect(() => createComputeProviderClient({ provider: 'daytona' })).toThrow(
      'Missing DAYTONA_API_KEY',
    );

    expect(() =>
      createComputeProviderClient({
        provider: 'daytona',
        config: { apiKey: 'daytona-key' } as DaytonaConfig,
      }),
    ).toThrow('Missing DAYTONA_SNAPSHOT_NAME');
  });

  it('resolves E2B credentials from env', () => {
    process.env.E2B_API_KEY = 'e2b-key';
    process.env.E2B_TEMPLATE_ID = 'roomote-worker';
    process.env.E2B_DOMAIN = 'e2b.example.test';

    try {
      createComputeProviderClient({ provider: 'e2b' });

      expect(e2bClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'e2b-key',
          templateId: 'roomote-worker',
          domain: 'e2b.example.test',
        }),
      );
    } finally {
      delete process.env.E2B_API_KEY;
      delete process.env.E2B_TEMPLATE_ID;
      delete process.env.E2B_DOMAIN;
    }
  });

  it('requires the E2B API key and template ID', () => {
    delete process.env.E2B_API_KEY;
    delete process.env.E2B_TEMPLATE_ID;

    expect(() => createComputeProviderClient({ provider: 'e2b' })).toThrow(
      'Missing E2B_API_KEY',
    );

    expect(() =>
      createComputeProviderClient({
        provider: 'e2b',
        config: { apiKey: 'e2b-key' } as E2bConfig,
      }),
    ).toThrow('Missing E2B_TEMPLATE_ID');
  });
});
