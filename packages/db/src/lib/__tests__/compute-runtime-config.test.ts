const { mockDecryptSecrets } = vi.hoisted(() => ({
  mockDecryptSecrets: vi.fn(),
}));

vi.mock('../../encryption', () => ({
  decryptSecrets: (...args: unknown[]) => mockDecryptSecrets(...args),
}));

import { resolveComputeProviderEnvValues } from '../compute-runtime-config';

type Executor = NonNullable<
  Parameters<typeof resolveComputeProviderEnvValues>[1]
>['executor'];

type EnvVarRow = { name: string; value: string };

function makeExecutor(rows: EnvVarRow[]): NonNullable<Executor> {
  // `where` must satisfy both call shapes used by the module: the direct
  // `inArray` read (awaited) and `resolveSavedWorkerImage`'s `.limit(1)` read.
  const whereResult = {
    limit: vi.fn(async () => rows),
    then: (resolve: (value: EnvVarRow[]) => unknown) => resolve(rows),
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => whereResult),
      })),
    })),
  } as unknown as NonNullable<Executor>;
}

describe('resolveComputeProviderEnvValues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptSecrets.mockImplementation(async (value) => value);
  });

  it('prefers runtime env values over saved and derived ones', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        MODAL_BASE_IMAGE_REF: 'registry.example.com/explicit:tag',
        RELEASE_VERSION: 'v1.2.3',
      },
      executor: makeExecutor([]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe(
      'registry.example.com/explicit:tag',
    );
  });

  it('prefers a saved deployment env var over the derived worker image', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        RELEASE_VERSION: 'v1.2.3',
      },
      executor: makeExecutor([
        {
          name: 'MODAL_BASE_IMAGE_REF',
          value: 'registry.example.com/saved:tag',
        },
      ]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe('registry.example.com/saved:tag');
  });

  it('derives the Modal base image from a registry-qualified worker image', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
      },
      executor: makeExecutor([]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
  });

  it('derives the Modal base image from the baked release version', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        RELEASE_VERSION: 'v1.2.3',
      },
      executor: makeExecutor([]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
  });

  it('ignores a saved shared worker image so release derivation can take effect', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        RELEASE_VERSION: 'v1.2.3',
      },
      executor: makeExecutor([
        {
          name: 'DOCKER_WORKER_IMAGE',
          value: 'ghcr.io/roocodeinc/roomote-worker:v9.9.9',
        },
      ]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe(
      'ghcr.io/roocodeinc/roomote-worker:v1.2.3',
    );
  });

  it('uses the development Modal base image when no hosted worker image is configured', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        NODE_ENV: 'development',
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'roomote-worker:local',
      },
      executor: makeExecutor([]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBe(
      'ghcr.io/roocodeinc/roomote-worker:latest',
    );
  });

  it('leaves the Modal base image unset when nothing is derivable', async () => {
    const values = await resolveComputeProviderEnvValues('modal', {
      runtimeEnv: {
        MODAL_TOKEN_ID: 'id',
        MODAL_TOKEN_SECRET: 'secret',
        DOCKER_WORKER_IMAGE: 'roomote-worker:local',
        RELEASE_VERSION: 'self-host-production',
      },
      executor: makeExecutor([]),
    });

    expect(values.MODAL_BASE_IMAGE_REF).toBeUndefined();
  });
});
