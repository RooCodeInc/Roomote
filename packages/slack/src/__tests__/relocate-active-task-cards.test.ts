import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTaskIds: vi.fn(),
  removeTask: vi.fn(),
  getData: vi.fn(),
  casMessageTs: vi.fn(),
  clearPendingCleanup: vi.fn(),
}));

vi.mock('../thread-active-tasks', () => ({
  getSlackThreadActiveTaskIds: mocks.getTaskIds,
  removeSlackThreadActiveTaskByTaskId: mocks.removeTask,
}));
vi.mock('../live-task-stream', () => ({
  getSlackLiveTaskStreamData: mocks.getData,
  compareAndSwapSlackLiveTaskMessageTs: mocks.casMessageTs,
  clearSlackLiveTaskPendingCleanup: mocks.clearPendingCleanup,
}));

import { relocateSlackThreadActiveTaskCards } from '../relocate-active-task-cards';

const rawMessage = {
  text: 'exact fallback',
  blocks: [
    {
      type: 'task_card',
      task_id: 'task-update-1',
      status: 'in_progress',
      title: 'Exact title',
    },
    {
      type: 'actions',
      block_id: 'interactive-state',
      elements: [
        {
          type: 'button',
          action_id: 'answer_task_input',
          value: '{"state":"unchanged"}',
        },
      ],
    },
  ],
  attachments: [{ fallback: 'exact attachment', color: '#123456' }],
};

function slackMock() {
  return {
    getRawMessage: vi.fn<
      (params: {
        channel: string;
        threadTs: string;
        messageTs: string;
      }) => Promise<typeof rawMessage | null>
    >(async () => rawMessage),
    postMessage: vi.fn<
      (message: {
        channel: string;
        thread_ts: string;
        text?: string;
        blocks?: unknown[];
        attachments?: unknown[];
      }) => Promise<string | undefined>
    >(async () => 'new-ts'),
    deleteMessage: vi.fn<
      (params: { channel: string; ts: string }) => Promise<boolean>
    >(async () => true),
  };
}

function cardData(taskId = 'task-1', messageTs = 'old-ts') {
  return {
    teamId: 'T1',
    channel: 'C1',
    threadTs: 'root-ts',
    taskId,
    taskUpdateId: `update-${taskId}`,
    title: 'Title',
    messageTs,
  };
}

describe('relocateSlackThreadActiveTaskCards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskIds.mockResolvedValue(['task-1']);
    mocks.getData.mockResolvedValue(cardData());
    mocks.casMessageTs.mockResolvedValue(true);
    mocks.clearPendingCleanup.mockResolvedValue(true);
    mocks.removeTask.mockResolvedValue({});
  });

  it('reposts the exact canonical payload, hands off the pointer, then deletes the old card', async () => {
    const slack = slackMock();

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: 'root-ts',
      ...rawMessage,
    });
    expect(slack.postMessage.mock.calls[0]?.[0]?.blocks).toEqual(
      rawMessage.blocks,
    );
    expect(slack.postMessage.mock.calls[0]?.[0]?.attachments).toEqual(
      rawMessage.attachments,
    );
    expect(mocks.casMessageTs).toHaveBeenCalledWith({
      taskId: 'task-1',
      expectedMessageTs: 'old-ts',
      nextMessageTs: 'new-ts',
    });
    expect(mocks.casMessageTs.mock.invocationCallOrder[0]).toBeLessThan(
      slack.deleteMessage.mock.invocationCallOrder[0]!,
    );
    expect(slack.deleteMessage).toHaveBeenCalledOnce();
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'old-ts',
    });
    expect(mocks.clearPendingCleanup).toHaveBeenCalledWith({
      taskId: 'task-1',
      currentMessageTs: 'new-ts',
      oldMessageTs: 'old-ts',
    });
  });

  it('keeps the old pointer and card when reposting fails', async () => {
    const slack = slackMock();
    slack.postMessage.mockResolvedValue(undefined);

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(mocks.casMessageTs).not.toHaveBeenCalled();
    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('deletes the new copy when the pointer CAS loses a race', async () => {
    mocks.casMessageTs.mockResolvedValue(false);
    const slack = slackMock();

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(slack.deleteMessage).toHaveBeenCalledOnce();
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'new-ts',
    });
  });

  it('retains atomic cleanup state after failed deletion and retries it before a later move', async () => {
    const slack = slackMock();
    slack.deleteMessage.mockResolvedValueOnce(false);

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });
    expect(mocks.clearPendingCleanup).not.toHaveBeenCalled();

    mocks.getData.mockResolvedValue({
      ...cardData('task-1', 'new-ts'),
      pendingOldMessageTs: 'old-ts',
    });
    slack.deleteMessage.mockClear();
    slack.deleteMessage.mockResolvedValue(true);
    slack.postMessage.mockResolvedValue('newer-ts');
    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(slack.deleteMessage).toHaveBeenNthCalledWith(1, {
      channel: 'C1',
      ts: 'old-ts',
    });
    expect(mocks.clearPendingCleanup).toHaveBeenCalledWith({
      taskId: 'task-1',
      currentMessageTs: 'new-ts',
      oldMessageTs: 'old-ts',
    });
  });

  it('does not create another copy while an older pending duplicate remains', async () => {
    mocks.getData.mockResolvedValue({
      ...cardData('task-1', 'new-ts'),
      pendingOldMessageTs: 'old-ts',
    });
    const slack = slackMock();
    slack.deleteMessage.mockResolvedValue(false);

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'old-ts',
    });
    expect(slack.getRawMessage).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('cleans a terminal pending duplicate without relocating the terminal card', async () => {
    mocks.getData.mockResolvedValue({
      ...cardData('task-1', 'new-ts'),
      pendingOldMessageTs: 'old-ts',
      relocationStopped: true,
    });
    const slack = slackMock();

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'old-ts',
    });
    expect(mocks.removeTask).toHaveBeenCalledWith('task-1');
    expect(slack.getRawMessage).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('relocates multiple cards in stable registry order and isolates failures', async () => {
    mocks.getTaskIds.mockResolvedValue(['task-1', 'task-2', 'task-3']);
    mocks.getData.mockImplementation(async (taskId: string) =>
      cardData(taskId, `old-${taskId}`),
    );
    const slack = slackMock();
    slack.getRawMessage.mockImplementation(async ({ messageTs }) => {
      if (messageTs === 'old-task-2') throw new Error('fetch failed');
      return { ...rawMessage, text: messageTs };
    });
    slack.postMessage.mockImplementation(async ({ text }) => `new-${text}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await relocateSlackThreadActiveTaskCards({
      slack: slack as never,
      channel: 'C1',
      threadTs: 'root-ts',
    });

    expect(
      slack.postMessage.mock.calls.map(([message]) => message.text),
    ).toEqual(['old-task-1', 'old-task-3']);
  });
});
