import { describe, expect, it, beforeEach, vi } from 'vitest';

const {
  findFirstMock,
  cloudJobFindFirstMock,
  environmentFindFirstMock,
  resolveEffectivePreviewRuntimeConfigMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  cloudJobFindFirstMock: vi.fn(),
  environmentFindFirstMock: vi.fn(),
  resolveEffectivePreviewRuntimeConfigMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskPullRequests: {
        findFirst: findFirstMock,
      },
      taskRuns: {
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
  resolveThreadReplyLinkedPr,
} from '../thread-reply-footer-context';

function mockEnvironmentBackedCloudJob(params?: {
  primaryPortName?: string | null;
}): void {
  cloudJobFindFirstMock.mockResolvedValue({
    payload: { environmentId: 'env-1' },
    primaryPortName: params?.primaryPortName ?? null,
  });
}

describe('thread reply footer context', () => {
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
  });

  it('builds PR URLs from repository and number', () => {
    expect(
      buildThreadReplyPrUrl({ repository: 'roomote/app', prNumber: 42 }),
    ).toBe('https://github.com/roomote/app/pull/42');
  });

  it('prefers the linked task PR and suppresses terminal linked PRs', async () => {
    findFirstMock.mockResolvedValueOnce({
      prUrl: 'https://github.com/roomote/app/pull/4321',
      prNumber: 4321,
      status: 'open',
    });

    await expect(
      resolveThreadReplyLinkedPr({
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
      }),
    ).resolves.toEqual({
      prNumber: 4321,
      prUrl: 'https://github.com/roomote/app/pull/4321',
    });

    findFirstMock.mockResolvedValueOnce({
      prUrl: 'https://github.com/roomote/app/pull/4321',
      prNumber: 4321,
      status: 'merged',
    });

    await expect(
      resolveThreadReplyLinkedPr({
        taskId: 'task-1',
        prRepo: 'roomote/app',
        prNumber: 1234,
      }),
    ).resolves.toBeNull();
  });

  it('falls back to the cloud-job PR and live preview context', async () => {
    mockEnvironmentBackedCloudJob({ primaryPortName: 'WEB' });
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
      linkedPr: {
        prNumber: 1234,
        prUrl: 'https://github.com/roomote/app/pull/1234',
      },
      livePreviewUrl: 'https://task-1-web.preview.example.com/auth/dev-login',
    });
  });

  it('omits live preview when no preview proxy base URL is available', async () => {
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
      resolveThreadReplyFooterContext({
        taskId: 'task-1',
        prRepo: null,
        prNumber: null,
      }),
    ).resolves.toEqual({
      linkedPr: null,
      livePreviewUrl: null,
    });
  });
});
