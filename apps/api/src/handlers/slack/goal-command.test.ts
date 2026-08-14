const mocks = vi.hoisted(() => ({
  findByChannel: vi.fn(),
  findByThread: vi.fn(),
  postMessage: vi.fn(),
  startGoal: vi.fn(),
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  findActiveSlackTaskRun: mocks.findByThread,
  findActiveSlackTaskRunByChannel: mocks.findByChannel,
}));

vi.mock('../tasks/startTaskGoal.js', () => ({
  startTaskGoal: mocks.startGoal,
}));

vi.mock('./helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: mocks.postMessage,
}));

import {
  findSlackGoalCommandTask,
  parseSlackGoalCommand,
  processSlackGoalCommand,
} from './goal-command.js';

describe('Slack Goal Mode command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startGoal.mockResolvedValue({ success: true });
    mocks.postMessage.mockResolvedValue(true);
    mocks.findByChannel.mockResolvedValue(null);
    mocks.findByThread.mockResolvedValue(null);
  });

  it.each([
    ['goal Ship the release', 'Ship the release'],
    ['/goal Ship the release', 'Ship the release'],
    ['<@U123> goal Ship the release', 'Ship the release'],
    ['<@U123>: /GOAL   Ship the release  ', 'Ship the release'],
  ])('parses %s', (text, objective) => {
    expect(parseSlackGoalCommand(text)).toEqual({ objective });
  });

  it.each(['goalkeeper notes', 'set a goal for this', '<@U123> continue'])(
    'does not intercept %s',
    (text) => {
      expect(parseSlackGoalCommand(text)).toBeNull();
    },
  );

  it('starts Goal Mode with Slack as the source and replies in the task thread', async () => {
    await processSlackGoalCommand({
      event: {
        type: 'app_mention',
        channel: 'C123',
        thread_ts: '100.000',
        user: 'U123',
        ts: '101.000',
        text: '<@UBOT> goal Ship the release',
      },
      slack: {} as never,
      teamId: 'T123',
      userId: 'user-1',
      taskId: 'task-1',
      threadTs: '100.000',
      command: { objective: 'Ship the release' },
    });

    expect(mocks.startGoal).toHaveBeenCalledWith({
      taskId: 'task-1',
      userId: 'user-1',
      objective: 'Ship the release',
      source: 'slack',
      clientMessageId: '101.000',
    });
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '100.000',
        text: 'Goal Mode enabled.',
      }),
    );
  });

  it('finds a later top-level DM command by channel and keeps the original task thread', async () => {
    mocks.findByChannel.mockResolvedValue({
      taskId: 'task-1',
      slackThreadTs: '100.000',
    });
    const event = {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U123',
      ts: '101.000',
      text: 'goal Ship the release',
    };

    const activeRun = await findSlackGoalCommandTask(event, 'T123');
    await processSlackGoalCommand({
      event,
      slack: {} as never,
      teamId: 'T123',
      userId: 'user-1',
      taskId: activeRun?.taskId ?? null,
      threadTs: activeRun?.slackThreadTs ?? event.ts,
      command: { objective: 'Ship the release' },
    });

    expect(mocks.findByChannel).toHaveBeenCalledWith('D123', {
      slackTeamId: 'T123',
    });
    expect(mocks.findByThread).not.toHaveBeenCalled();
    expect(mocks.startGoal).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: '100.000' }),
    );
  });

  it('explains that Goal Mode needs an active task', async () => {
    await processSlackGoalCommand({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        ts: '101.000',
        text: 'goal Ship the release',
      },
      slack: {} as never,
      teamId: 'T123',
      userId: 'user-1',
      taskId: null,
      threadTs: '101.000',
      command: { objective: 'Ship the release' },
    });

    expect(mocks.startGoal).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('active task thread or DM'),
      }),
    );
  });

  it('rejects attachments on a Goal Mode command', async () => {
    await processSlackGoalCommand({
      event: {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        ts: '101.000',
        text: 'goal Ship the release',
        files: [{ id: 'F123' } as never],
      },
      slack: {} as never,
      teamId: 'T123',
      userId: 'user-1',
      taskId: 'task-1',
      threadTs: '101.000',
      command: { objective: 'Ship the release' },
    });

    expect(mocks.startGoal).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Goal Mode does not support attachments.',
      }),
    );
  });
});
