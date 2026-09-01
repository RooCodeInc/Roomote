const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/task-1'),
}));

vi.mock('../../task-run-queue', () => ({
  enqueueTask: mocks.enqueueTask,
}));

vi.mock('../../task-url', () => ({
  getTaskUrl: mocks.getTaskUrl,
}));

import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import {
  createFastAgentSlackTaskLauncher,
  createFastAgentWebTaskLauncher,
} from '../fast-agent-task-launcher';

describe('createFastAgentSlackTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockImplementation(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-1' });
        return { taskId: 'task-1' };
      },
    );
  });

  it('launches a communication-isolated child owned by the Fast parent', async () => {
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
      messageId: '100.002',
    });
    const order: string[] = [];
    const postKickoff = vi.fn(async () => {
      order.push('kickoff');
    });
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-1' });
        order.push('queued');
        return { taskId: 'task-1' };
      },
    );

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: 'env-1',
        model: 'anthropic/claude-sonnet-5',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff,
      }),
    ).resolves.toEqual({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      {
        task: {
          type: TaskPayloadKind.StandardTask,
          payload: {
            repo: ALL_REPOSITORIES,
            description: 'Add a regression test',
            communicationProvider: 'slack',
            communicationTeamId: 'T123',
            communicationTeamDomain: 'acme',
            communicationChannelId: 'C123',
            communicationThreadId: '100.001',
            communicationMessageId: '100.002',
            slackConversationUrl:
              'https://acme.slack.com/archives/C123/p100002?thread_ts=100.001&cid=C123',
            communicationContextInherited: true,
            reportConsumer: 'orchestrator',
            fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
            fastAgentParent: {
              sessionId: '11111111-1111-4111-8111-111111111111',
              conversation: {
                surface: 'slack',
                workspaceId: 'T123',
                conversationId: '100.001',
                replyTarget: {
                  channelId: 'C123',
                  threadId: '100.001',
                },
              },
            },
            environmentId: 'env-1',
            harnessModelOverrides: {
              'opencode-server': 'anthropic/claude-sonnet-5',
            },
          },
        },
        initiator: { kind: 'user', userId: 'user-1' },
        workflow: 'standard',
        surface: 'slack',
        trigger: 'message',
      },
      { beforeEnqueue: expect.any(Function) },
    );
    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
    });
    expect(
      mocks.enqueueTask.mock.calls[0]?.[0]?.task.payload,
    ).not.toHaveProperty('images');
    expect(order).toEqual(['kickoff', 'queued']);
  });

  it('supports platform-event launches without a human message ID', async () => {
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
    });

    await launchTask({
      prompt: 'Investigate separately',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    const task = mocks.enqueueTask.mock.calls[0]?.[0]?.task;
    expect(task.payload).not.toHaveProperty('communicationMessageId');
    expect(task.payload).not.toHaveProperty('communicationTeamDomain');
    expect(task.payload.slackConversationUrl).toBe(
      'https://slack.com/app_redirect?channel=C123&team=T123',
    );
    expect(task.payload).not.toHaveProperty('liveTaskStream');
  });

  it('treats the all-repositories sentinel like an omitted environment', async () => {
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
    });

    await launchTask({
      prompt: 'Update every repository',
      environmentId: ALL_REPOSITORIES,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    const task = mocks.enqueueTask.mock.calls[0]?.[0]?.task;
    expect(task.payload).toMatchObject({ repo: ALL_REPOSITORIES });
    expect(task.payload).not.toHaveProperty('environmentId');
  });

  it('retains multiple Fast turn images in the child task payload', async () => {
    const images = [
      'data:image/png;base64,cG5nLWJ5dGVz',
      'data:image/webp;base64,d2VicC1ieXRlcw==',
    ];
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
    });

    await launchTask({
      prompt: 'Implement the UI shown in these screenshots',
      images,
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.enqueueTask.mock.calls[0]?.[0]?.task.payload.images).toEqual(
      images,
    );
  });

  it('runs afterKickoff inside the launch gate', async () => {
    const order: string[] = [];
    const afterKickoff = vi.fn(async () => {
      order.push('afterKickoff');
    });
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: {
            id: number;
            taskId: string;
          }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ id: 42, taskId: 'task-1' });
        order.push('queued');
        return { taskId: 'task-1' };
      },
    );
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
      liveTaskStream: true,
      afterKickoff,
    });

    await launchTask({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(async () => {
        order.push('kickoff');
      }),
    });

    expect(order).toEqual(['kickoff', 'afterKickoff', 'queued']);
    expect(afterKickoff).toHaveBeenCalledWith(
      { id: 42, taskId: 'task-1' },
      {
        prompt: 'Add a regression test',
        taskUrl: 'https://roomote.example/task/task-1',
      },
    );
    expect(mocks.enqueueTask.mock.calls[0]?.[0]?.task.payload).toMatchObject({
      liveTaskStream: true,
    });
  });

  it('runs queue-failure cleanup after kickoff preparation succeeds', async () => {
    const queueError = new Error('Redis unavailable');
    const onQueueFailure = vi
      .fn()
      .mockRejectedValue(new Error('Slack unavailable'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: {
            id: number;
            taskId: string;
          }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ id: 42, taskId: 'task-1' });
        throw queueError;
      },
    );
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
      afterKickoff: vi.fn(),
      onQueueFailure,
    });

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).rejects.toBe(queueError);
    expect(onQueueFailure).toHaveBeenCalledWith({ id: 42, taskId: 'task-1' });
    expect(consoleError).toHaveBeenCalledWith(
      '[Fast Agent] Failed to settle task task-1 after queueing failed: Slack unavailable',
    );
    consoleError.mockRestore();
  });

  it('tells the kickoff when the launcher renders the task link itself', async () => {
    const postKickoff = vi.fn();
    await createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.001',
      rendersTaskLink: true,
    })({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff,
    });

    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
      taskLinkRendered: true,
    });
  });

  it('does not make the child runnable when afterKickoff fails', async () => {
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.002',
      afterKickoff: vi.fn().mockRejectedValue(new Error('stream failed')),
    });
    let queued = false;
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-1' });
        queued = true;
        return { taskId: 'task-1' };
      },
    );

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).rejects.toThrow('stream failed');
    expect(queued).toBe(false);
  });

  it('does not make the child runnable when the parent kickoff fails', async () => {
    const launchTask = createFastAgentSlackTaskLauncher({
      userId: 'user-1',
      teamId: 'T123',
      channelId: 'C123',
      threadTs: '100.002',
    });
    const postKickoff = vi.fn().mockRejectedValue(new Error('Slack failed'));
    let queued = false;
    mocks.enqueueTask.mockImplementationOnce(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-1' });
        queued = true;
        return { taskId: 'task-1' };
      },
    );

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff,
      }),
    ).rejects.toThrow('Slack failed');
    expect(queued).toBe(false);
  });
});

describe('createFastAgentWebTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockImplementation(
      async (
        _input: unknown,
        options: {
          beforeEnqueue: (taskRun: { taskId: string }) => Promise<void>;
        },
      ) => {
        await options.beforeEnqueue({ taskId: 'task-1' });
        return { taskId: 'task-1' };
      },
    );
  });

  it('keeps the kickoff free of a duplicate task link', async () => {
    const postKickoff = vi.fn();

    await createFastAgentWebTaskLauncher({
      userId: 'user-1',
      conversation: {
        surface: 'web',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
      },
    })({
      prompt: 'Fix checkout',
      environmentId: null,
      branch: 'feature/source-branch',
      launchIdempotencyKey: 'artifact-build:launch-1',
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff,
    });

    expect(postKickoff).toHaveBeenCalledWith({
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
      taskLinkRendered: true,
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          payload: expect.objectContaining({
            branch: 'feature/source-branch',
            launchIdempotencyKey: 'artifact-build:launch-1',
          }),
        }),
      }),
      expect.any(Object),
    );
  });
});
