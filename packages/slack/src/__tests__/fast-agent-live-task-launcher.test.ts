const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getSessionForTask: vi.fn(),
  getSlackLiveTaskStreamData: vi.fn(),
  setSlackLiveTaskStreamData: vi.fn(),
  postMessage: vi.fn(),
  postMessageDetailed: vi.fn(),
  updateMessage: vi.fn(),
  settleSlackLiveTaskCardForRun: vi.fn(),
}));

// Contract-faithful stand-in for the cloud-agents launcher (hook ordering is
// covered by its own tests): kickoff, then afterKickoff inside the launch
// gate.
vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentSlackTaskLauncher: (params: {
    liveTaskStream?: boolean;
    rendersTaskLink?: boolean;
    afterKickoff?: (
      taskRun: { id: number; taskId: string },
      context: { prompt: string; taskUrl: string },
    ) => Promise<void>;
    onQueueFailure?: (taskRun: { id: number; taskId: string }) => Promise<void>;
    [key: string]: unknown;
  }) => {
    const {
      liveTaskStream,
      afterKickoff,
      onQueueFailure,
      rendersTaskLink,
      ...rest
    } = params;
    return async (input: {
      prompt: string;
      environmentId: string | null;
      parentSessionId: string;
      postKickoff: (task: {
        taskId: string;
        taskUrl?: string;
      }) => Promise<void>;
    }) => {
      const taskUrl = 'https://roomote.example/task/task-1';
      await input.postKickoff({ taskId: 'task-1', taskUrl });
      await afterKickoff?.(
        { id: 42, taskId: 'task-1' },
        { prompt: input.prompt, taskUrl },
      );
      try {
        await mocks.enqueueTask({
          ...rest,
          liveTaskStream,
          rendersTaskLink,
          environmentId: input.environmentId,
        });
      } catch (error) {
        await onQueueFailure?.({ id: 42, taskId: 'task-1' });
        throw error;
      }
      return { success: true, taskId: 'task-1', taskUrl };
    };
  },
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getSessionForTask: mocks.getSessionForTask,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example' },
}));

vi.mock('../live-task-stream', () => ({
  buildSlackLiveTaskTitle: (prompt: string) => prompt,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData: mocks.setSlackLiveTaskStreamData,
}));

vi.mock('../settle-live-task-card', () => ({
  settleSlackLiveTaskCardForRun: mocks.settleSlackLiveTaskCardForRun,
}));

import { RunStatus } from '@roomote/types';

import { createFastAgentSlackLiveTaskLauncher } from '../fast-agent-live-task-launcher';

function createLauncher() {
  return createFastAgentSlackLiveTaskLauncher({
    slack: {
      postMessage: mocks.postMessage,
      postMessageDetailed: mocks.postMessageDetailed,
      updateMessage: mocks.updateMessage,
    },
    userId: 'user-1',
    teamId: 'T123',
    teamDomain: 'acme',
    channelId: 'C123',
    threadTs: '100.001',
    messageId: '100.002',
  });
}

describe('createFastAgentSlackLiveTaskLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueTask.mockResolvedValue(undefined);
    mocks.getSessionForTask.mockResolvedValue(null);
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    mocks.postMessageDetailed.mockResolvedValue({ ts: 'card-ts' });
    mocks.postMessage.mockResolvedValue('fallback-ts');
    mocks.setSlackLiveTaskStreamData.mockResolvedValue(undefined);
    mocks.updateMessage.mockResolvedValue(true);
    mocks.settleSlackLiveTaskCardForRun.mockResolvedValue(undefined);
  });

  const taskLinkFallback = {
    channel: 'C123',
    thread_ts: '100.001',
    text: 'Open in Roomote: https://roomote.example/task/task-1',
    blocks: [
      {
        type: 'markdown',
        text: '[Open in Roomote](https://roomote.example/task/task-1)',
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };

  it('posts a starting placeholder card in the parent thread and records the task title', async () => {
    const launchTask = createLauncher();

    await expect(
      launchTask({
        prompt: 'Add a regression test',
        environmentId: 'env-1',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toEqual({
      success: true,
      taskId: 'task-1',
      taskUrl: 'https://roomote.example/task/task-1',
    });

    expect(mocks.postMessageDetailed).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '100.001',
      text: 'Preparing workspace…\n<https://roomote.example/task/task-1|Open in Roomote>',
      blocks: [
        expect.objectContaining({
          type: 'task_card',
          task_id: 'roomote-task-task-1',
          title: 'Preparing workspace…',
          status: 'in_progress',
          sources: [
            {
              type: 'url',
              url: 'https://roomote.example/task/task-1',
              text: 'Open in Roomote',
            },
          ],
        }),
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(
      mocks.postMessageDetailed.mock.calls[0]?.[0]?.blocks[0],
    ).not.toHaveProperty('output');
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith('task-1', {
      teamId: 'T123',
      channel: 'C123',
      messageTs: 'card-ts',
      taskId: 'task-1',
      taskUpdateId: 'roomote-task-task-1',
      threadTs: '100.001',
      title: 'Add a regression test',
      taskUrl: 'https://roomote.example/task/task-1',
    });
    expect(mocks.enqueueTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'T123',
      teamDomain: 'acme',
      channelId: 'C123',
      threadTs: '100.001',
      messageId: '100.002',
      liveTaskStream: true,
      rendersTaskLink: true,
      environmentId: 'env-1',
    });
  });

  it('links the card to the session when the task already has one', async () => {
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-1' });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    const sessionUrl = 'https://roomote.example/sessions/session-1?task=task-1';
    expect(mocks.postMessageDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            sources: [
              { type: 'url', url: sessionUrl, text: 'Open in Roomote' },
            ],
          }),
        ],
      }),
    );
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ taskUrl: sessionUrl }),
    );
  });

  it('reuses an existing card instead of posting a second one', async () => {
    mocks.getSlackLiveTaskStreamData.mockResolvedValue({
      teamId: 'T123',
      channel: 'C123',
      messageTs: 'existing-ts',
      taskId: 'task-1',
      taskUpdateId: 'roomote-task-task-1',
      threadTs: '100.001',
      title: 'Add a regression test',
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('settles the card when queueing fails after card creation', async () => {
    const queueError = new Error('Redis unavailable');
    mocks.enqueueTask.mockRejectedValue(queueError);

    await expect(
      createLauncher()({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).rejects.toBe(queueError);

    expect(mocks.settleSlackLiveTaskCardForRun).toHaveBeenCalledWith({
      taskId: 'task-1',
      payload: { liveTaskStream: true },
      status: RunStatus.Canceled,
    });
  });

  it('posts a plain task link when Slack rejects the card', async () => {
    mocks.postMessageDetailed.mockResolvedValue({
      slackErrorCode: 'invalid_blocks',
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(taskLinkFallback);
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('posts nothing when the thread root is gone', async () => {
    mocks.postMessageDetailed.mockResolvedValue({
      skippedMissingThreadRoot: true,
    });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('still launches the task and posts the task link when the card path throws', async () => {
    mocks.getSlackLiveTaskStreamData.mockRejectedValue(new Error('redis down'));

    await expect(
      createLauncher()({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
    expect(mocks.postMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith(taskLinkFallback);
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('settles an untracked card instead of leaving it spinning when the pointer cannot be stored', async () => {
    mocks.setSlackLiveTaskStreamData.mockRejectedValue(new Error('READONLY'));

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'card-ts',
      message: expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'task_card',
            status: 'error',
            sources: [
              {
                type: 'url',
                url: 'https://roomote.example/task/task-1',
                text: 'Open in Roomote',
              },
            ],
          }),
        ],
      }),
    });
    // The card still carries the task link, so no separate link message.
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to a task link when the untracked card cannot be settled either', async () => {
    mocks.setSlackLiveTaskStreamData.mockRejectedValue(new Error('READONLY'));
    mocks.updateMessage.mockResolvedValue(false);

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });

    expect(mocks.postMessage).toHaveBeenCalledWith(taskLinkFallback);
  });
});
