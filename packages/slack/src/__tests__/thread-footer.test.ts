const {
  findFirstMock,
  cloudJobFindFirstMock,
  environmentFindFirstMock,
  resolveEffectivePreviewRuntimeConfigMock,
  redisGetMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  cloudJobFindFirstMock: vi.fn(),
  environmentFindFirstMock: vi.fn(),
  resolveEffectivePreviewRuntimeConfigMock: vi.fn(),
  redisGetMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskPullRequests: {
        findFirst: findFirstMock,
      },
      cloudJobs: {
        findFirst: cloudJobFindFirstMock,
      },
      environments: {
        findFirst: environmentFindFirstMock,
      },
    },
  },
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  taskPullRequests: {
    taskId: 'taskId',
  },
  cloudJobs: {
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

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    get: redisGetMock,
  })),
}));

import { getSlackThreadFooterText } from '../thread-footer';

function mockEnvironmentBackedCloudJob(params?: {
  primaryPortName?: string | null;
}): void {
  cloudJobFindFirstMock.mockResolvedValue({
    payload: { environmentId: 'env-1' },
    primaryPortName: params?.primaryPortName ?? null,
  });
}

describe('getSlackThreadFooterText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(null);
    cloudJobFindFirstMock.mockResolvedValue(null);
    environmentFindFirstMock.mockResolvedValue(null);
    resolveEffectivePreviewRuntimeConfigMock.mockResolvedValue({
      effective: {
        previewProxyBaseUrl: 'https://preview.example.com',
      },
    });
    redisGetMock.mockResolvedValue(null);
  });

  it('prefers the linked task PR and uses the explicit-mention marker', async () => {
    findFirstMock.mockResolvedValue({
      prUrl: 'https://github.com/roomote/app/pull/4321',
      prNumber: 4321,
      status: 'open',
    });
    redisGetMock.mockResolvedValue('1');

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
      '_Working on <https://github.com/roomote/app/pull/4321|PR #4321>, reply with @-mention or use the <https://app.example.com/task/task-1|web app>._',
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
    ).resolves.toBe(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('falls back to the cloud job PR when no linked task PR row exists', async () => {
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
      '_Working on <https://github.com/roomote/app/pull/1234|PR #1234>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('includes the live preview link alongside the PR for environment-backed tasks', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
      '_Working on <https://github.com/roomote/app/pull/1234|PR #1234>, <https://task-1-web.preview.example.com/auth/dev-login|live preview>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('includes the live preview link without a PR for environment-backed tasks', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
      '_Working on a <https://task-1-web.preview.example.com/auth/dev-login|live preview>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('slugs the primary port name from the environment config when the cloud job has none', async () => {
    mockEnvironmentBackedCloudJob();
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
      '_Working on a <https://task-1-my-app.preview.example.com/?path=/story/example|live preview>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('falls back to the base preview URL when the primary port has no initial path', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
      '_Working on a <https://task-1-web.preview.example.com|live preview>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('omits the live preview link when environment previews are disabled', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('omits the live preview link when the environment has no configured ports', async () => {
    mockEnvironmentBackedCloudJob();
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
    ).resolves.toBe(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('omits the live preview link for repo-only tasks without an environment', async () => {
    cloudJobFindFirstMock.mockResolvedValue({
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
      '_Working on <https://github.com/roomote/app/pull/1234|PR #1234>, reply or use the <https://app.example.com/task/task-1|web app>._',
    );

    expect(environmentFindFirstMock).not.toHaveBeenCalled();
  });

  it('omits the live preview link when no preview proxy base URL is resolvable', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
    ).resolves.toBe(
      '_Reply or use the <https://app.example.com/task/task-1|web app>._',
    );
  });

  it('keeps the explicit-mention instruction with the live preview link', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000 }],
      },
    });
    redisGetMock.mockResolvedValue('1');

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
      '_Working on a <https://task-1-web.preview.example.com|live preview>, reply with @-mention or use the <https://app.example.com/task/task-1|web app>._',
    );
  });
});
