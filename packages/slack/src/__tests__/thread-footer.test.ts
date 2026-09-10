import { RunStatus } from '@roomote/types';

const {
  findFirstMock,
  findManyMock,
  taskRunFindFirstMock,
  environmentFindFirstMock,
  resolveEffectivePreviewRuntimeConfigMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  taskRunFindFirstMock: vi.fn(),
  environmentFindFirstMock: vi.fn(),
  resolveEffectivePreviewRuntimeConfigMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskPullRequests: {
        findFirst: findFirstMock,
        findMany: findManyMock,
      },
      taskRuns: {
        findFirst: taskRunFindFirstMock,
      },
      environments: {
        findFirst: environmentFindFirstMock,
      },
    },
  },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  getSessionForTask: vi.fn().mockResolvedValue(null),
  taskPullRequests: {
    taskId: 'taskId',
  },
  taskRuns: {
    taskId: 'taskId',
  },
  environments: {
    id: 'id',
  },
  resolveEffectivePreviewRuntimeConfig:
    resolveEffectivePreviewRuntimeConfigMock,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    PREVIEW_PROXY_BASE_URL: 'https://preview.example.com',
    PREVIEW_DOMAINS: 'preview.example.com',
  },
}));

import {
  buildSlackThreadFooterText,
  getSlackThreadFooterText,
} from '../thread-footer';

function mockEnvironmentBackedTaskRun(params?: {
  primaryPortName?: string | null;
}): void {
  taskRunFindFirstMock.mockResolvedValue({
    payload: { environmentId: 'env-1' },
    primaryPortName: params?.primaryPortName ?? null,
    status: RunStatus.Idle,
  });
}

describe('getSlackThreadFooterText', () => {
  it('renders the owning Session transcript separately from task navigation', () => {
    expect(
      buildSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1?utm_source=slack',
        webAppUrl: 'https://app.example.com/sessions/owner',
        runningTasks: {
          count: 1,
          url: 'https://app.example.com/sessions/owner?task=task-1',
        },
      }),
    ).toBe(
      '_<https://app.example.com/sessions/owner?task=task-1|1 running task> · <https://app.example.com/sessions/owner?utm_source=slack&task=task-1|Web app>_',
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([]);
    taskRunFindFirstMock.mockResolvedValue(null);
    environmentFindFirstMock.mockResolvedValue(null);
    resolveEffectivePreviewRuntimeConfigMock.mockResolvedValue({
      effective: {
        previewProxyBaseUrl: 'https://preview.example.com',
      },
    });
  });

  it('prefers the linked task PR', async () => {
    findFirstMock.mockResolvedValue({
      prUrl: 'https://github.com/roomote/app/pull/4321',
      prNumber: 4321,
      status: 'open',
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://github.com/roomote/app/pull/4321|PR #4321> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('suppresses PR footer text when the linked task PR is terminal', async () => {
    findFirstMock.mockResolvedValue({
      prUrl: 'https://github.com/roomote/app/pull/4321',
      prNumber: 4321,
      status: 'merged',
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe('_<https://app.example.com/task/task-1|Web app>_');
  });

  it('falls back to the task run PR when no linked task PR row exists', async () => {
    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://github.com/roomote/app/pull/1234|PR #1234> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('includes the live preview link alongside the PR for environment-backed tasks', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000, initial_path: '/auth/dev-login' }],
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://task-1-web.preview.example.com/auth/dev-login|Live preview> · <https://github.com/roomote/app/pull/1234|PR #1234> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('includes the live preview link without a PR for environment-backed tasks', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000, initial_path: '/auth/dev-login' }],
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://task-1-web.preview.example.com/auth/dev-login|Live preview> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('slugs the primary port name from the environment config when the task run has none', async () => {
    mockEnvironmentBackedTaskRun();
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [
          { name: 'API', port: 4000 },
          {
            name: 'MY_APP',
            port: 3000,
            primary: true,
            initial_path: '/?path=/story/example',
          },
        ],
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://task-1-my-app.preview.example.com/?path=/story/example|Live preview> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('falls back to the base preview URL when the primary port has no initial path', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000 }],
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://task-1-web.preview.example.com|Live preview> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('includes the live preview link even when the config contains the deprecated previews_enabled: false', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000 }],
        previews_enabled: false,
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://task-1-web.preview.example.com|Live preview> · <https://app.example.com/task/task-1|Web app>_',
    );
  });

  it('omits the live preview link when the environment has no configured ports', async () => {
    mockEnvironmentBackedTaskRun();
    environmentFindFirstMock.mockResolvedValue({
      config: {},
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe('_<https://app.example.com/task/task-1|Web app>_');
  });

  it('omits the live preview link for repo-only tasks without an environment', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      payload: { repo: 'roomote/app' },
      primaryPortName: null,
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe(
      '_<https://github.com/roomote/app/pull/1234|PR #1234> · <https://app.example.com/task/task-1|Web app>_',
    );

    expect(environmentFindFirstMock).not.toHaveBeenCalled();
  });

  it('omits the live preview link when no preview proxy base URL is resolvable', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000 }],
      },
    });
    resolveEffectivePreviewRuntimeConfigMock.mockResolvedValue({
      effective: {
        previewProxyBaseUrl: null,
      },
    });

    await expect(
      getSlackThreadFooterText({
        taskUrl: 'https://app.example.com/task/task-1',
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
        channelId: 'C123',
        threadTs: '111.000',
      }),
    ).resolves.toBe('_<https://app.example.com/task/task-1|Web app>_');
  });
});
