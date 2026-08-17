const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getTaskUrl: vi.fn(() => 'https://roomote.example/task/task-1'),
  getSlackLiveTaskStreamData: vi.fn(),
  setSlackLiveTaskStreamData: vi.fn(),
  startTaskStream: vi.fn(),
  appendTaskStream: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: mocks.enqueueTask,
  getTaskUrl: mocks.getTaskUrl,
}));

vi.mock('@roomote/slack', () => ({
  buildSlackLiveTaskTitle: (prompt: string) => prompt,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData: mocks.setSlackLiveTaskStreamData,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { tasks: { findFirst: vi.fn().mockResolvedValue(null) } } },
  eq: vi.fn(),
  tasks: { id: 'tasks.id', title: 'tasks.title' },
}));

import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';

import { createFastAgentTaskLauncher } from './fast-agent-task-launcher.js';

describe('createFastAgentTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockImplementation(
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
        return { taskId: 'task-1' };
      },
    );
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    mocks.startTaskStream.mockResolvedValue('stream-ts');
    mocks.appendTaskStream.mockResolvedValue(true);
    mocks.setSlackLiveTaskStreamData.mockResolvedValue(undefined);
  });

  it('launches a communication-isolated child owned by the Fast parent', async () => {
    const launchTask = createFastAgentTaskLauncher({
      event: {
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: '100.001',
        user: 'U123',
        text: 'Add a regression test',
        ts: '100.002',
      } as never,
      slackInstallation: {
        teamDomain: 'acme',
      } as never,
      userMapping: {
        slackUserId: 'U123',
      } as never,
      userId: 'user-1',
      teamId: 'T123',
      slack: {
        startTaskStream: mocks.startTaskStream,
        appendTaskStream: mocks.appendTaskStream,
      } as never,
    });
    const order: string[] = [];
    const postKickoff = vi.fn(async () => {
      order.push('kickoff');
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
    expect(mocks.startTaskStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '100.001',
        recipientTeamId: 'T123',
        recipientUserId: 'U123',
        task: expect.objectContaining({
          id: 'roomote-task-task-1',
          title: 'Add a regression test',
          status: 'in_progress',
        }),
      }),
    );
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        messageTs: 'stream-ts',
        taskId: 'task-1',
      }),
    );
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
            fastAgentParent: {
              sessionId: '11111111-1111-4111-8111-111111111111',
              slackTeamId: 'T123',
              slackChannel: 'C123',
              slackThreadTs: '100.001',
            },
            liveTaskStream: true,
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

  it('does not make the child runnable when the parent kickoff fails', async () => {
    const launchTask = createFastAgentTaskLauncher({
      event: {
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U123',
        text: 'Add a regression test',
        ts: '100.002',
      } as never,
      slackInstallation: {} as never,
      userMapping: { slackUserId: 'U123' } as never,
      userId: 'user-1',
      teamId: 'T123',
      slack: {
        startTaskStream: mocks.startTaskStream,
        appendTaskStream: mocks.appendTaskStream,
      } as never,
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
