const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getSlackLiveTaskStreamData: vi.fn(),
  setSlackLiveTaskStreamData: vi.fn(),
  postMessage: vi.fn(),
  postMessageDetailed: vi.fn(),
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
    [key: string]: unknown;
  }) => {
    const { liveTaskStream, afterKickoff, rendersTaskLink, ...rest } = params;
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
      await mocks.enqueueTask({
        ...rest,
        liveTaskStream,
        rendersTaskLink,
        environmentId: input.environmentId,
      });
      return { success: true, taskId: 'task-1', taskUrl };
    };
  },
}));

vi.mock('../live-task-stream', () => ({
  buildSlackLiveTaskTitle: (prompt: string) => prompt,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData: mocks.setSlackLiveTaskStreamData,
}));

import { createFastAgentSlackLiveTaskLauncher } from '../fast-agent-live-task-launcher';

function createLauncher() {
  return createFastAgentSlackLiveTaskLauncher({
    slack: {
      postMessage: mocks.postMessage,
      postMessageDetailed: mocks.postMessageDetailed,
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
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    mocks.postMessageDetailed.mockResolvedValue({ ts: 'card-ts' });
    mocks.postMessage.mockResolvedValue('fallback-ts');
    mocks.setSlackLiveTaskStreamData.mockResolvedValue(undefined);
  });

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
      text: 'Starting task…\n<https://roomote.example/task/task-1|Open the task>',
      blocks: [
        expect.objectContaining({
          type: 'task_card',
          task_id: 'roomote-task-task-1',
          title: 'Starting task…',
          status: 'in_progress',
          sources: [
            {
              type: 'url',
              url: 'https://roomote.example/task/task-1',
              text: 'View task',
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

  it('reuses an existing card instead of posting a second one', async () => {
    mocks.getSlackLiveTaskStreamData.mockResolvedValue({
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

    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '100.001',
      text: 'Open the task: https://roomote.example/task/task-1',
      blocks: [
        {
          type: 'markdown',
          text: '[Open the task](https://roomote.example/task/task-1)',
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('still launches the task when the card cannot be posted', async () => {
    mocks.postMessageDetailed.mockRejectedValue(new Error('slack down'));

    await expect(
      createLauncher()({
        prompt: 'Add a regression test',
        environmentId: null,
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        postKickoff: vi.fn(),
      }),
    ).resolves.toMatchObject({ success: true, taskId: 'task-1' });
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });
});
