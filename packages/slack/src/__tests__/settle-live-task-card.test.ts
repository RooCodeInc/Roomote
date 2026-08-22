const mocks = vi.hoisted(() => ({
  getSlackLiveTaskStreamData: vi.fn(),
  findInstallation: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  slackInstallations: { isActive: 'isActive', teamId: 'teamId' },
  db: {
    query: {
      slackInstallations: { findFirst: mocks.findInstallation },
    },
  },
}));

vi.mock('../live-task-stream', () => ({
  buildSlackLiveTaskTitle: (title: string) => title,
  getSlackLiveTaskStreamData: mocks.getSlackLiveTaskStreamData,
}));

vi.mock('../slack-notifier', () => ({
  SlackNotifier: class {
    constructor(public token: string) {}
    updateMessage = mocks.updateMessage;
  },
}));

import { RunStatus } from '@roomote/types';

import { settleSlackLiveTaskCardForRun } from '../settle-live-task-card';

const cardData = {
  teamId: 'T123',
  channel: 'C123',
  messageTs: 'card-ts',
  taskId: 'task-1',
  taskUpdateId: 'roomote-task-task-1',
  threadTs: '100.001',
  title: 'Add a regression test',
  taskUrl: 'https://roomote.example/task/task-1',
};

describe('settleSlackLiveTaskCardForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(cardData);
    mocks.findInstallation.mockResolvedValue({ botAccessToken: 'xoxb-test' });
    mocks.updateMessage.mockResolvedValue(true);
  });

  it('marks a canceled task card as an error with the owning team token', async () => {
    await settleSlackLiveTaskCardForRun({
      taskId: 'task-1',
      payload: { liveTaskStream: true },
      status: RunStatus.Canceled,
      taskTitle: 'Generated title',
    });

    expect(mocks.findInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          and: [{ eq: ['isActive', true] }, { eq: ['teamId', 'T123'] }],
        },
      }),
    );
    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'card-ts',
      message: expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'task_card',
            title: 'Generated title',
            status: 'error',
            output: {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [{ type: 'text', text: 'Task canceled.' }],
                },
              ],
            },
          }),
        ],
      }),
    });
  });

  it('does nothing for runs without a card', async () => {
    await settleSlackLiveTaskCardForRun({
      taskId: 'task-1',
      payload: { description: 'no card' },
      status: RunStatus.Failed,
    });
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);
    await settleSlackLiveTaskCardForRun({
      taskId: 'task-2',
      payload: { liveTaskStream: true },
      status: RunStatus.Failed,
    });

    expect(mocks.updateMessage).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.getSlackLiveTaskStreamData.mockRejectedValue(new Error('redis'));

    await expect(
      settleSlackLiveTaskCardForRun({
        taskId: 'task-1',
        payload: { liveTaskStream: true },
        status: RunStatus.Failed,
      }),
    ).resolves.toBeUndefined();
  });
});
