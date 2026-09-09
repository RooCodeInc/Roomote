import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionForFastConversationMock,
  selectWhereMock,
  resolveThreadReplyFooterContextMock,
  taskRunFindFirstMock,
} = vi.hoisted(() => ({
  getSessionForFastConversationMock: vi.fn(),
  selectWhereMock: vi.fn(),
  resolveThreadReplyFooterContextMock: vi.fn(),
  taskRunFindFirstMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { taskRuns: { findFirst: taskRunFindFirstMock } },
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
  taskRuns: { taskId: 'taskId' },
}));

vi.mock('../thread-reply-footer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../thread-reply-footer-context')>()),
  resolveThreadReplyFooterContext: resolveThreadReplyFooterContextMock,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

import { resolveFastSessionReplyFooterContext } from '../fast-session-footer';
import { RunStatus } from '@roomote/types';

describe('resolveFastSessionReplyFooterContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionForFastConversationMock.mockResolvedValue({ id: 'session-1' });
    selectWhereMock.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    taskRunFindFirstMock.mockResolvedValue({
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
    });
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
      runningTasks: { count: 0, url: 'https://roomote.example/tasks' },
    });

    expect(getSessionForFastConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      'fast-session-1',
    );
    expect(resolveThreadReplyFooterContextMock).toHaveBeenCalledTimes(2);
  });

  it.each([null, { id: 'session-1' }])(
    'omits status without coding-task history (%j)',
    async (session) => {
      getSessionForFastConversationMock.mockResolvedValue(session);
      selectWhereMock.mockResolvedValue([]);
      const context = await resolveFastSessionReplyFooterContext({
        sessionId: 'conversation',
      });
      expect(context.runningTasks).toBeUndefined();
      expect(taskRunFindFirstMock).not.toHaveBeenCalled();
    },
  );

  it('links one executing follow-up to its owning Session, not the Fast conversation', async () => {
    taskRunFindFirstMock.mockResolvedValueOnce({
      status: RunStatus.Idle,
      taskPhase: 'running',
    });
    const context = await resolveFastSessionReplyFooterContext({
      sessionId: 'conversation',
    });
    expect(context.runningTasks).toEqual({
      count: 1,
      url: 'https://roomote.example/sessions/session-1?task=task-1',
    });
  });

  it('links multiple executing tasks to the supported task-list route', async () => {
    taskRunFindFirstMock.mockResolvedValue({
      status: RunStatus.Running,
      taskPhase: 'running',
    });
    const context = await resolveFastSessionReplyFooterContext({
      sessionId: 'conversation',
    });
    expect(context.runningTasks).toEqual({
      count: 2,
      url: 'https://roomote.example/tasks',
    });
  });

  it.each([
    { status: RunStatus.Running, taskPhase: 'waiting_for_prompt' },
    { status: RunStatus.Idle, taskPhase: 'waiting_for_prompt' },
    { status: RunStatus.Completed, taskPhase: 'running' },
    null,
  ])('does not count non-executing latest runs: %j', async (run) => {
    taskRunFindFirstMock.mockResolvedValue(run);
    const context = await resolveFastSessionReplyFooterContext({
      sessionId: 'conversation',
    });
    expect(context.runningTasks?.count).toBe(0);
    expect(context.livePreviewUrl).toBe('https://preview.example');
  });

  it('requests the latest run deterministically, never an arbitrary older running run', async () => {
    await resolveFastSessionReplyFooterContext({ sessionId: 'conversation' });
    const query = taskRunFindFirstMock.mock.calls[0]![0];
    const desc = vi.fn((value) => `desc:${value}`);
    expect(query.orderBy({ createdAt: 'created', id: 'id' }, { desc })).toEqual(
      ['desc:created', 'desc:id'],
    );
    expect(query.where).toEqual({ eq: ['taskId', 'task-1'] });
  });
});
