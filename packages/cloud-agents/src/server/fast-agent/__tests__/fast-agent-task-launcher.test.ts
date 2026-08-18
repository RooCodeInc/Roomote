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

import { createFastAgentSlackTaskLauncher } from '../fast-agent-task-launcher';

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
            communicationContextInherited: true,
            fastAgentSessionId: '11111111-1111-4111-8111-111111111111',
            fastAgentParent: {
              sessionId: '11111111-1111-4111-8111-111111111111',
              slackTeamId: 'T123',
              slackChannel: 'C123',
              slackThreadTs: '100.001',
            },
            environmentId: 'env-1',
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
