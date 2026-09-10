import type { TaskRun } from '@roomote/db/server';
import { RunStatus, type EnvironmentConfig } from '@roomote/types';

const {
  taskRunFindFirstMock,
  environmentFindFirstMock,
  deploymentSettingsFindFirstMock,
} = vi.hoisted(() => ({
  taskRunFindFirstMock: vi.fn(),
  environmentFindFirstMock: vi.fn(),
  deploymentSettingsFindFirstMock: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: taskRunFindFirstMock,
      },
      environments: {
        findFirst: environmentFindFirstMock,
      },
      deploymentSettings: {
        findFirst: deploymentSettingsFindFirstMock,
      },
    },
  },
}));

import { resolveRequest } from './resolver';

function createRunningTaskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 1,
    taskId: 'outertask12345',
    status: RunStatus.Running,
    payload: {
      environmentId: 'env_app',
    },
    machineDomains: {
      WEB: 'http://127.0.0.1:3000',
    },
    proxyPorts: {
      WEB: 49152,
    },
    authBypassValue: null,
    authBypassHeaderName: null,
    ...overrides,
  } as unknown as TaskRun;
}

function createEnvironmentConfig(
  overrides: Partial<EnvironmentConfig> = {},
): EnvironmentConfig {
  return {
    name: 'Test Environment',
    repositories: [
      {
        repository: 'Roomote/Roomote',
      },
    ],
    ...overrides,
  };
}

describe('resolveRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRunFindFirstMock.mockResolvedValue(createRunningTaskRun());
    deploymentSettingsFindFirstMock.mockResolvedValue({ metadata: {} });
  });

  it('preserves configured bypass paths for preview ports', async () => {
    environmentFindFirstMock.mockResolvedValue({
      config: createEnvironmentConfig({
        ports: [
          {
            name: 'WEB',
            port: 3000,
            auth_bypass_paths: ['/health'],
          },
        ],
      }),
    });

    const result = await resolveRequest({ taskId: 'outertask12345' }, 'web');

    expect(result.authBypassPaths).toEqual(['/health']);
  });

  it('resolves preview port auth settings from environment configs', async () => {
    environmentFindFirstMock.mockResolvedValue({
      config: createEnvironmentConfig({
        ports: [
          {
            name: 'WEB',
            port: 3000,
            unauthenticated: true,
            wildcard_prefix: true,
            auth_bypass_paths: ['/healthz'],
          },
        ],
      }),
    });

    const result = await resolveRequest({ taskId: 'outertask12345' }, 'web');

    expect(result).toMatchObject({
      status: 'active',
      requiresAuth: false,
      hasAuthProxy: true,
      wildcardPrefix: true,
      authBypassPaths: ['/healthz'],
    });
  });

  it('requires auth for system API surfaces that are not user-defined ports', async () => {
    taskRunFindFirstMock.mockResolvedValue(
      createRunningTaskRun({
        machineDomains: {
          API: 'http://127.0.0.1:3001',
        },
        proxyPorts: {
          API: 49152,
        },
      }),
    );
    environmentFindFirstMock.mockResolvedValue({
      config: createEnvironmentConfig({
        ports: [],
      }),
    });

    const result = await resolveRequest({ taskId: 'outertask12345' }, 'api');

    expect(result).toMatchObject({
      status: 'active',
      sandboxUrl: 'http://127.0.0.1:3001',
    });
    expect(result.authBypassPaths).toBeUndefined();
  });

  it('only uses explicitly configured auth bypass paths for user-defined API ports', async () => {
    taskRunFindFirstMock.mockResolvedValue(
      createRunningTaskRun({
        machineDomains: {
          API: 'http://127.0.0.1:3001',
        },
        proxyPorts: {
          API: 49152,
        },
      }),
    );
    environmentFindFirstMock.mockResolvedValue({
      config: createEnvironmentConfig({
        ports: [
          {
            name: 'API',
            port: 3001,
            auth_bypass_paths: ['/health'],
          },
        ],
      }),
    });

    const result = await resolveRequest({ taskId: 'outertask12345' }, 'api');

    expect(result.authBypassPaths).toEqual(['/health']);
  });

  it('proxies sandbox server requests without preview auth', async () => {
    taskRunFindFirstMock.mockResolvedValue(
      createRunningTaskRun({
        machineDomains: {
          SANDBOX_SERVER: 'http://roomote-worker-1:4200',
        },
        proxyPorts: null,
      }),
    );

    const result = await resolveRequest(
      { taskId: 'outertask12345' },
      'sandbox-server',
    );

    expect(result).toMatchObject({
      status: 'active',
      sandboxUrl: 'http://roomote-worker-1:4200',
      requiresAuth: false,
      hasAuthProxy: false,
      requestedPortKey: 'SANDBOX_SERVER',
    });
  });

  it('fails closed for legacy GUI hosts', async () => {
    const result = await resolveRequest({ taskId: 'outertask12345' }, 'gui');

    expect(taskRunFindFirstMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'not_found',
      requestedPortKey: 'GUI',
    });
  });

  it('keeps completed Modal previews resumable after seven days', async () => {
    taskRunFindFirstMock.mockResolvedValue(
      createRunningTaskRun({
        status: RunStatus.Completed,
        vendor: 'modal',
        snapshotId: 'im-old-modal-snapshot',
        snapshotCreatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      }),
    );

    const result = await resolveRequest({ taskId: 'outertask12345' }, 'web');

    expect(result).toMatchObject({
      status: 'resumable',
      snapshotId: 'im-old-modal-snapshot',
    });
  });
});
