const mocks = vi.hoisted(() => ({
  getSlackLiveTaskStreamData: vi.fn(),
  findInstallation: vi.fn(),
  updateMessage: vi.fn(),
  setSlackThreadActiveTask: vi.fn(),
  removeSlackThreadActiveTaskByTaskId: vi.fn(),
  refreshSlackThreadActiveTaskFooter: vi.fn(),
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

vi.mock('../thread-active-tasks', () => ({
  setSlackThreadActiveTask: mocks.setSlackThreadActiveTask,
  removeSlackThreadActiveTaskByTaskId:
    mocks.removeSlackThreadActiveTaskByTaskId,
}));

vi.mock('../thread-reply-footer-ops', () => ({
  refreshSlackThreadActiveTaskFooter: mocks.refreshSlackThreadActiveTaskFooter,
}));

import { RunStatus } from '@roomote/types';

import {
  renderSlackLiveTaskCard,
  settleSlackLiveTaskCardForRun,
} from '../settle-live-task-card';

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
    mocks.setSlackThreadActiveTask.mockResolvedValue(undefined);
    mocks.removeSlackThreadActiveTaskByTaskId.mockResolvedValue({
      teamId: 'T123',
      channel: 'C123',
      threadTs: '100.001',
      version: 'route-version',
    });
    mocks.refreshSlackThreadActiveTaskFooter.mockResolvedValue(undefined);
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
                  elements: [{ type: 'text', text: 'Stopped.' }],
                },
              ],
            },
          }),
        ],
      }),
    });
    expect(mocks.removeSlackThreadActiveTaskByTaskId).toHaveBeenCalledWith(
      'task-1',
    );
    expect(mocks.refreshSlackThreadActiveTaskFooter).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', threadTs: '100.001' }),
    );
    expect(
      mocks.removeSlackThreadActiveTaskByTaskId.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.refreshSlackThreadActiveTaskFooter.mock.invocationCallOrder[0]!,
    );
  });

  it('reports whether a card exists and whether Slack accepted the render', async () => {
    await expect(
      renderSlackLiveTaskCard({
        taskId: 'task-1',
        status: 'in_progress',
        details: 'Working.',
      }),
    ).resolves.toEqual({ card: true, updated: true });

    mocks.updateMessage.mockResolvedValue(false);
    await expect(
      renderSlackLiveTaskCard({ taskId: 'task-1', status: 'in_progress' }),
    ).resolves.toEqual({ card: true, updated: false });

    mocks.findInstallation.mockResolvedValue(undefined);
    await expect(
      renderSlackLiveTaskCard({ taskId: 'task-1', status: 'in_progress' }),
    ).resolves.toEqual({ card: false, updated: false });
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

  it('removes and refreshes a terminal task after its live-card record expires', async () => {
    mocks.getSlackLiveTaskStreamData.mockResolvedValue(null);

    await expect(
      renderSlackLiveTaskCard({ taskId: 'task-1', status: 'complete' }),
    ).resolves.toEqual({ card: false, updated: false });

    expect(mocks.removeSlackThreadActiveTaskByTaskId).toHaveBeenCalledWith(
      'task-1',
    );
    expect(mocks.findInstallation).toHaveBeenCalledOnce();
    expect(mocks.refreshSlackThreadActiveTaskFooter).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', threadTs: '100.001' }),
    );
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

  it('keeps canonical card updates working when pinned task state fails', async () => {
    mocks.removeSlackThreadActiveTaskByTaskId.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      renderSlackLiveTaskCard({ taskId: 'task-1', status: 'complete' }),
    ).resolves.toEqual({ card: true, updated: true });

    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove active task'),
    );
  });
});
