const mocks = vi.hoisted(() => ({
  settleSlack: vi.fn(),
  settleTelegram: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  settleSlackLiveTaskCardForRun: mocks.settleSlack,
}));

vi.mock('../../telegram-live-task-stream', () => ({
  settleTelegramLiveTaskStreamForRun: mocks.settleTelegram,
}));

import { RunStatus } from '@roomote/types';

import { settleLiveTaskMessageOnExit } from '../settle-live-task-message-on-exit';

describe('settleLiveTaskMessageOnExit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settleSlack.mockResolvedValue(undefined);
    mocks.settleTelegram.mockResolvedValue(undefined);
  });

  it('settles every provider-native message after direct cancellation', async () => {
    const run = {
      id: 42,
      taskId: 'task-1',
      payload: { liveTaskStream: true, communicationProvider: 'telegram' },
    };

    await settleLiveTaskMessageOnExit(run, RunStatus.Canceled, 'Task title');

    expect(mocks.settleSlack).toHaveBeenCalledWith({
      taskId: 'task-1',
      payload: run.payload,
      status: RunStatus.Canceled,
      taskTitle: 'Task title',
    });
    expect(mocks.settleTelegram).toHaveBeenCalledWith({
      taskId: 'task-1',
      payload: run.payload,
      status: RunStatus.Canceled,
    });
  });

  it('does not settle successful runs from the control plane', async () => {
    await settleLiveTaskMessageOnExit(
      { id: 42, taskId: 'task-1', payload: { liveTaskStream: true } },
      RunStatus.Completed,
    );

    expect(mocks.settleSlack).not.toHaveBeenCalled();
    expect(mocks.settleTelegram).not.toHaveBeenCalled();
  });
});
