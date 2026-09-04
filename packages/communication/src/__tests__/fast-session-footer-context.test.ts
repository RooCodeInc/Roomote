import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionForFastConversationMock,
  selectWhereMock,
  resolveThreadReplyFooterContextMock,
  resolveThreadReplyLivePreviewUrlMock,
} = vi.hoisted(() => ({
  getSessionForFastConversationMock: vi.fn(),
  selectWhereMock: vi.fn(),
  resolveThreadReplyFooterContextMock: vi.fn(),
  resolveThreadReplyLivePreviewUrlMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: selectWhereMock })),
        })),
      })),
    })),
  },
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((value: unknown) => ({ asc: value })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  getSessionForFastConversation: getSessionForFastConversationMock,
  isNull: vi.fn((value: unknown) => ({ isNull: value })),
  sessionTasks: {
    sessionId: 'sessionId',
    taskId: 'taskId',
    attachedAt: 'attachedAt',
  },
  tasks: {
    id: 'id',
    deletedAt: 'deletedAt',
  },
}));

vi.mock('../thread-reply-footer-context', () => ({
  resolveThreadReplyFooterContext: resolveThreadReplyFooterContextMock,
  resolveThreadReplyLivePreviewUrl: resolveThreadReplyLivePreviewUrlMock,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

import {
  resolveFastSessionLivePreviewUrl,
  resolveFastSessionReplyFooterContext,
} from '../fast-session-footer';

describe('resolveFastSessionReplyFooterContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionForFastConversationMock.mockResolvedValue({ id: 'session-1' });
    selectWhereMock.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    resolveThreadReplyFooterContextMock.mockImplementation(
      async ({ taskId }: { taskId: string }) => ({
        linkedPrs:
          taskId === 'task-1'
            ? [
                {
                  prNumber: 42,
                  prUrl: 'https://github.com/acme/widgets/pull/42',
                },
              ]
            : [
                {
                  prNumber: 42,
                  prUrl: 'https://github.com/acme/widgets/pull/42',
                },
                {
                  prNumber: 7,
                  prUrl: 'https://github.com/acme/api/pull/7',
                },
              ],
        livePreviewUrl: taskId === 'task-1' ? 'https://preview.example' : null,
      }),
    );
  });

  it('accumulates and deduplicates pull requests from every unified Session task', async () => {
    await expect(
      resolveFastSessionReplyFooterContext({ sessionId: 'fast-session-1' }),
    ).resolves.toEqual({
      linkedPrs: [
        {
          prNumber: 42,
          prUrl: 'https://github.com/acme/widgets/pull/42',
        },
        {
          prNumber: 7,
          prUrl: 'https://github.com/acme/api/pull/7',
        },
      ],
      livePreviewUrl: 'https://preview.example',
    });

    expect(getSessionForFastConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      'fast-session-1',
    );
    expect(resolveThreadReplyFooterContextMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveFastSessionLivePreviewUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionForFastConversationMock.mockResolvedValue({ id: 'session-1' });
    selectWhereMock.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
  });

  it('returns the first linked task preview URL', async () => {
    resolveThreadReplyLivePreviewUrlMock.mockImplementation(
      async (taskId: string) =>
        taskId === 'task-2' ? 'https://preview.example/app' : null,
    );

    await expect(
      resolveFastSessionLivePreviewUrl('fast-session-1'),
    ).resolves.toBe('https://preview.example/app');
  });

  it('returns null when no linked task exposes a preview', async () => {
    resolveThreadReplyLivePreviewUrlMock.mockResolvedValue(null);

    await expect(
      resolveFastSessionLivePreviewUrl('fast-session-1'),
    ).resolves.toBeNull();
  });

  it('returns null when the session is unknown', async () => {
    getSessionForFastConversationMock.mockResolvedValue(null);

    await expect(
      resolveFastSessionLivePreviewUrl('fast-session-1'),
    ).resolves.toBeNull();
    expect(resolveThreadReplyLivePreviewUrlMock).not.toHaveBeenCalled();
  });
});
