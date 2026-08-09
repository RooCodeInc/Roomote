import { describe, expect, it, beforeEach, vi } from 'vitest';

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
  buildThreadReplyPrUrl,
  resolveThreadReplyFooterContext,
  resolveThreadReplyLinkedPrs,
} from '../thread-reply-footer-context';

function mockEnvironmentBackedTaskRun(params?: {
  primaryPortName?: string | null;
}): void {
  taskRunFindFirstMock.mockResolvedValue({
    payload: { environmentId: 'env-1' },
    primaryPortName: params?.primaryPortName ?? null,
  });
}

describe('thread reply footer context', () => {
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

  it('builds PR URLs from repository and number', () => {
    expect(
      buildThreadReplyPrUrl({ repository: 'roomote/app', prNumber: 42 }),
    ).toBe('https://github.com/roomote/app/pull/42');
  });

  it('returns every active linked task PR', async () => {
    findManyMock.mockResolvedValue([
      {
        prUrl: 'https://github.com/roomote/app/pull/3',
        prNumber: 3,
        status: 'open',
      },
      {
        prUrl: 'https://github.com/roomote/api/pull/2',
        prNumber: 2,
        status: 'draft',
      },
      {
        prUrl: 'https://github.com/roomote/docs/pull/1',
        prNumber: 1,
        status: 'merged',
      },
    ]);

    await expect(
      resolveThreadReplyLinkedPrs({
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
      }),
    ).resolves.toEqual([
      {
        prNumber: 3,
        prUrl: 'https://github.com/roomote/app/pull/3',
      },
      {
        prNumber: 2,
        prUrl: 'https://github.com/roomote/api/pull/2',
      },
    ]);
  });

  it('falls back to the task-run PR and live preview context', async () => {
    mockEnvironmentBackedTaskRun({ primaryPortName: 'WEB' });
    environmentFindFirstMock.mockResolvedValue({
      config: {
        ports: [{ name: 'WEB', port: 3000, initial_path: '/auth/dev-login' }],
      },
    });

    await expect(
      resolveThreadReplyFooterContext({
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
      }),
    ).resolves.toEqual({
      linkedPrs: [
        {
          prNumber: 1234,
          prUrl: 'https://github.com/roomote/app/pull/1234',
        },
      ],
      livePreviewUrl: 'https://task-1-web.preview.example.com/auth/dev-login',
    });
  });

  it('omits live preview when no preview proxy base URL is available', async () => {
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
      resolveThreadReplyFooterContext({
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
      }),
    ).resolves.toEqual({
      linkedPrs: [],
      livePreviewUrl: null,
    });
  });
});
