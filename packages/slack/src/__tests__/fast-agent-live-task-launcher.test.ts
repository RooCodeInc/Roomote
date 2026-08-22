const mocks = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  getSlackLiveTaskStreamData: vi.fn(),
  setSlackLiveTaskStreamData: vi.fn(),
  postMessage: vi.fn(),
  updateMessage: vi.fn(),
  findTask: vi.fn(),
}));

// Contract-faithful stand-in for the cloud-agents launcher (hook ordering is
// covered by its own tests): kickoff, then afterKickoff inside the launch
// gate, then afterLaunch once queued.
vi.mock('@roomote/cloud-agents/server', () => ({
  createFastAgentSlackTaskLauncher: (params: {
    liveTaskStream?: boolean;
    afterKickoff?: (
      taskRun: { id: number; taskId: string },
      context: { prompt: string; taskUrl: string },
    ) => Promise<void>;
    afterLaunch?: (context: { taskId: string; prompt: string }) => unknown;
    [key: string]: unknown;
  }) => {
    const { liveTaskStream, afterKickoff, afterLaunch, ...rest } = params;
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
        environmentId: input.environmentId,
      });
      void afterLaunch?.({ taskId: 'task-1', prompt: input.prompt });
      return { success: true, taskId: 'task-1', taskUrl };
    };
  },
}));

vi.mock('../live-task-stream', () => ({
  buildSlackLiveTaskTitle: (prompt: string) => prompt,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
  setSlackLiveTaskStreamData: mocks.setSlackLiveTaskStreamData,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { tasks: { findFirst: mocks.findTask } } },
  eq: vi.fn(),
  tasks: { id: 'tasks.id', title: 'tasks.title' },
}));

import { createFastAgentSlackLiveTaskLauncher } from '../fast-agent-live-task-launcher';

function createLauncher() {
  return createFastAgentSlackLiveTaskLauncher({
    slack: {
      postMessage: mocks.postMessage,
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
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    mocks.postMessage.mockResolvedValue('card-ts');
    mocks.updateMessage.mockResolvedValue(true);
    mocks.setSlackLiveTaskStreamData.mockResolvedValue(undefined);
    mocks.findTask.mockResolvedValue(null);
  });

  it('posts a task card in the parent thread and records it', async () => {
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

    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '100.001',
      text: 'Add a regression test',
      blocks: [
        expect.objectContaining({
          type: 'task_card',
          task_id: 'roomote-task-task-1',
          title: 'Add a regression test',
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

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.setSlackLiveTaskStreamData).not.toHaveBeenCalled();
  });

  it('still launches the task when the card cannot be posted', async () => {
    mocks.postMessage.mockRejectedValue(new Error('slack down'));

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

  it('renames the card once the generated task title exists', async () => {
    mocks.getSlackLiveTaskStreamData
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        channel: 'C123',
        messageTs: 'card-ts',
        taskId: 'task-1',
        taskUpdateId: 'roomote-task-task-1',
        threadTs: '100.001',
        title: 'Add a regression test',
        taskUrl: 'https://roomote.example/task/task-1',
      });
    mocks.findTask.mockResolvedValue({ title: 'Regression test for parser' });

    await createLauncher()({
      prompt: 'Add a regression test',
      environmentId: null,
      parentSessionId: '11111111-1111-4111-8111-111111111111',
      postKickoff: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(mocks.updateMessage).toHaveBeenCalledWith({
        channel: 'C123',
        ts: 'card-ts',
        message: {
          text: 'Regression test for parser',
          blocks: [
            expect.objectContaining({
              type: 'task_card',
              task_id: 'roomote-task-task-1',
              title: 'Regression test for parser',
              status: 'in_progress',
            }),
          ],
        },
      });
    });
    expect(mocks.setSlackLiveTaskStreamData).toHaveBeenLastCalledWith(
      'task-1',
      expect.objectContaining({ title: 'Regression test for parser' }),
    );
  });
});
