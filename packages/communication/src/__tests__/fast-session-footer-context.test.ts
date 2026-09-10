import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionForFastConversationMock,
  selectWhereMock,
  resolveThreadReplyFooterContextMock,
  latestRunsMock,
  latestRunsQuery,
} = vi.hoisted(() => ({
  getSessionForFastConversationMock: vi.fn(),
  selectWhereMock: vi.fn(),
  resolveThreadReplyFooterContextMock: vi.fn(),
  latestRunsMock: vi.fn(),
  latestRunsQuery: {
    selectDistinctOn: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
  },
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
    // One DISTINCT ON query returns every linked task's latest run.
    selectDistinctOn: vi.fn((...args: unknown[]) => {
      latestRunsQuery.selectDistinctOn(...args);
      return {
        from: vi.fn(() => ({
          where: vi.fn((...whereArgs: unknown[]) => {
            latestRunsQuery.where(...whereArgs);
            return {
              orderBy: vi.fn((...orderArgs: unknown[]) => {
                latestRunsQuery.orderBy(...orderArgs);
                return latestRunsMock();
              }),
            };
          }),
        })),
      };
    }),
  },
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((value: unknown) => ({ asc: value })),
  desc: vi.fn((value: unknown) => ({ desc: value })),
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
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
  taskRuns: {
    id: 'id',
    taskId: 'taskId',
    status: 'status',
    taskPhase: 'taskPhase',
    createdAt: 'createdAt',
  },
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
    getSessionForFastConversationMock.mockResolvedValue({
      id: 'session-1',
      activityAt: 1_700_000_000,
    });
    selectWhereMock.mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    latestRunsMock.mockResolvedValue([
      {
        taskId: 'task-1',
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      },
      {
        taskId: 'task-2',
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      },
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
      runningTasks: { count: 0, url: 'https://roomote.example/tasks' },
      sessionActivityAt: 1_700_000_000_000,
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
      expect(latestRunsMock).not.toHaveBeenCalled();
    },
  );

  it('links one executing follow-up to its owning Session, not the Fast conversation', async () => {
    latestRunsMock.mockResolvedValueOnce([
      { taskId: 'task-1', status: RunStatus.Idle, taskPhase: 'running' },
      {
        taskId: 'task-2',
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      },
    ]);
    const context = await resolveFastSessionReplyFooterContext({
      sessionId: 'conversation',
    });
    expect(context.runningTasks).toEqual({
      count: 1,
      url: 'https://roomote.example/sessions/session-1?task=task-1',
    });
  });

  it('links multiple executing tasks to the supported task-list route', async () => {
    latestRunsMock.mockResolvedValue([
      { taskId: 'task-1', status: RunStatus.Running, taskPhase: 'running' },
      { taskId: 'task-2', status: RunStatus.Running, taskPhase: 'running' },
    ]);
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
    latestRunsMock.mockResolvedValue(
      run
        ? [
            { taskId: 'task-1', ...run },
            { taskId: 'task-2', ...run },
          ]
        : [],
    );
    const context = await resolveFastSessionReplyFooterContext({
      sessionId: 'conversation',
    });
    expect(context.runningTasks?.count).toBe(0);
    expect(context.livePreviewUrl).toBe('https://preview.example');
  });

  it('requests every task latest run in one deterministic query, never an arbitrary older running run', async () => {
    await resolveFastSessionReplyFooterContext({ sessionId: 'conversation' });
    expect(latestRunsMock).toHaveBeenCalledTimes(1);
    expect(latestRunsQuery.selectDistinctOn).toHaveBeenCalledWith(['taskId'], {
      taskId: 'taskId',
      status: 'status',
      taskPhase: 'taskPhase',
    });
    expect(latestRunsQuery.where).toHaveBeenCalledWith({
      inArray: ['taskId', ['task-1', 'task-2']],
    });
    expect(latestRunsQuery.orderBy).toHaveBeenCalledWith(
      'taskId',
      { desc: 'createdAt' },
      { desc: 'id' },
    );
  });
});
