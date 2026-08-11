const { findEnvironmentMock } = vi.hoisted(() => ({
  findEnvironmentMock: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    environments: {
      findEnvironment: findEnvironmentMock,
    },
  },
}));

import {
  buildWorkspaceConfig,
  findRuntimeEnvironmentConfig,
} from './workspace-config';

describe('findRuntimeEnvironmentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the saved config as-is', async () => {
    const environmentConfig = {
      name: 'App',
      repositories: [{ repository: 'Roomote/example-app' }],
    };

    findEnvironmentMock.mockResolvedValue({
      id: 'env_123',
      config: environmentConfig,
    });

    await expect(findRuntimeEnvironmentConfig('env_123')).resolves.toEqual(
      environmentConfig,
    );
  });

  it('returns undefined when the environment does not exist', async () => {
    findEnvironmentMock.mockResolvedValue(undefined);

    await expect(
      findRuntimeEnvironmentConfig('env_missing'),
    ).resolves.toBeUndefined();
  });
});

describe('buildWorkspaceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the saved environment config for environment workspaces', async () => {
    findEnvironmentMock.mockResolvedValue({
      id: 'env_123',
      config: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
      },
    });

    await expect(
      buildWorkspaceConfig({ environmentId: 'env_123' }),
    ).resolves.toMatchObject({
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig: {
        name: 'App',
        repositories: [{ repository: 'Roomote/example-app' }],
      },
    });
  });

  it('uses a pinned config without refetching the environment', async () => {
    const environmentConfig = {
      name: 'Pinned App',
      repositories: [{ repository: 'Roomote/pinned-app' }],
    };

    await expect(
      buildWorkspaceConfig({
        environmentId: 'env_123',
        environmentConfig,
      }),
    ).resolves.toMatchObject({
      type: 'environment',
      environmentId: 'env_123',
      environmentConfig,
    });
    expect(findEnvironmentMock).not.toHaveBeenCalled();
  });
});
