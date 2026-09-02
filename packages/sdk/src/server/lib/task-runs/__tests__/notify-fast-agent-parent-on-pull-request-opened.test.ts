import type { TaskRun } from '@roomote/db/server';

const mocks = vi.hoisted(() => {
  return {
    recordLifecycle: vi.fn(),
    enqueueParentEvent: vi.fn(),
    getTaskUrl: vi.fn(() => 'https://roomote.example/task/child-task'),
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {},
  recordTaskRunLifecycleEvent: mocks.recordLifecycle,
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('../../fast-agent-parent-event-queue', () => ({
  enqueueFastAgentParentEventForRun: mocks.enqueueParentEvent,
}));

import { notifyFastAgentParentOnPullRequestOpened } from '../notify-fast-agent-parent-on-pull-request-opened';

const fastParent = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  conversation: {
    surface: 'slack' as const,
    workspaceId: 'T123',
    conversationId: '100.001',
    replyTarget: { channelId: 'C123', threadId: '100.001' },
  },
};

const discordFastParent = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  conversation: {
    surface: 'discord' as const,
    workspaceId: 'guild-1',
    conversationId: 'interaction-1',
    replyTarget: { channelId: 'channel-1' },
  },
};

function makeRun(payload: Record<string, unknown>): TaskRun {
  return {
    id: 200,
    taskId: 'child-task',
    payload,
    result: null,
    error: null,
  } as TaskRun;
}

const pullRequest = {
  provider: 'github' as const,
  host: 'github.com',
  repository: 'acme/web',
  number: 42,
  title: '[Fix] Keep the PR in the closeout',
  url: 'https://github.com/acme/web/pull/42',
  status: 'open' as const,
};

describe('notifyFastAgentParentOnPullRequestOpened', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueParentEvent.mockResolvedValue({
      eventKey: 'event-key',
      queued: true,
    });
    mocks.recordLifecycle.mockResolvedValue(undefined);
  });

  it('passes structured pull request context to the Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({ fastAgentParent: discordFastParent }),
      untrustedTaskGeneratedContext:
        'Fixed startup by treating absent local secrets as optional.',
      pullRequest,
    });

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith({
      parent: discordFastParent,
      runId: 200,
      event: {
        type: 'pull_request_opened',
        taskId: 'child-task',
        runId: 200,
        taskUrl: 'https://roomote.example/task/child-task',
        untrustedTaskGeneratedContext:
          'Fixed startup by treating absent local secrets as optional.',
        pullRequest,
      },
    });
    expect(mocks.getTaskUrl).toHaveBeenCalledWith({
      taskId: 'child-task',
      utm: {
        source: 'discord',
        campaign: 'fast-delegation-pr-opened',
      },
    });
    expect(mocks.recordLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'fast_agent_parent_pr_opened_event',
          prUrl: pullRequest.url,
        }),
      }),
    );
  });

  it('omits blank task-generated context so metadata remains the fallback', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({ fastAgentParent: fastParent }),
      untrustedTaskGeneratedContext: '   ',
      pullRequest,
    });

    expect(mocks.enqueueParentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.not.objectContaining({
          untrustedTaskGeneratedContext: expect.anything(),
        }),
      }),
    );
  });

  it('does nothing for a task without a Fast parent', async () => {
    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({}),
      pullRequest,
    });

    expect(mocks.enqueueParentEvent).not.toHaveBeenCalled();
  });

  it('does not record lifecycle history when terminal settlement wins admission', async () => {
    mocks.enqueueParentEvent.mockResolvedValueOnce({
      eventKey: 'event-key',
      queued: false,
    });

    await notifyFastAgentParentOnPullRequestOpened({
      run: makeRun({ fastAgentParent: fastParent }),
      pullRequest,
    });

    expect(mocks.recordLifecycle).not.toHaveBeenCalled();
  });

  it('fails only when durable queue admission fails', async () => {
    mocks.enqueueParentEvent.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      notifyFastAgentParentOnPullRequestOpened({
        run: makeRun({ fastAgentParent: fastParent }),
        pullRequest,
      }),
    ).rejects.toThrow('database unavailable');
    expect(mocks.recordLifecycle).not.toHaveBeenCalled();
  });

  it('does not fail admitted events when lifecycle recording fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.recordLifecycle.mockRejectedValueOnce(
      new Error('lifecycle unavailable'),
    );

    await expect(
      notifyFastAgentParentOnPullRequestOpened({
        run: makeRun({ fastAgentParent: fastParent }),
        pullRequest,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.enqueueParentEvent).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
