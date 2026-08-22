const mocks = vi.hoisted(() => ({
  appendTaskStream: vi.fn(),
  stopTaskStream: vi.fn(),
  updateMessage: vi.fn(),
  sdkGetStreamData: vi.fn(),
  sdkClearStreamData: vi.fn(),
  sdkFindFirstInstallation: vi.fn(),
}));

vi.mock('@roomote/slack/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack/client')>()),
  SlackNotifier: class {
    appendTaskStream = mocks.appendTaskStream;
    stopTaskStream = mocks.stopTaskStream;
    updateMessage = mocks.updateMessage;
  },
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      getSlackLiveTaskStreamData: mocks.sdkGetStreamData,
      clearSlackLiveTaskStreamData: mocks.sdkClearStreamData,
    },
    slackInstallations: {
      findFirst: mocks.sdkFindFirstInstallation,
    },
  },
}));

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/sdk/client';

import {
  finishSlackLiveTaskStream,
  getSlackLiveTaskStreamRunTaskCallbacks,
  startSlackLiveTaskStream,
  updateSlackLiveTaskStream,
} from '../slack-live-task-stream';

const streamData = {
  channel: 'C123',
  messageTs: 'stream-ts',
  taskId: 'task-1',
  taskUpdateId: 'roomote-task-task-1',
  threadTs: '100.001',
  title: 'Fix the button',
  taskUrl: 'https://roomote.example/task/task-1',
};

// The module caches stream data per run id for the process lifetime, so
// every test uses a fresh run id.
let nextRunId = 100;

function createTaskRun(
  overrides: { payloadKind?: TaskPayloadKind; payload?: unknown } = {},
): TaskRun {
  return {
    id: nextRunId++,
    taskId: 'task-1',
    payloadKind: overrides.payloadKind ?? TaskPayloadKind.StandardTask,
    payload: overrides.payload ?? {
      description: 'Fix the button',
      liveTaskStream: true,
    },
  } as unknown as TaskRun;
}

const todos = (current: string) => [
  { id: '1', content: 'Inspect the code', status: 'completed' as const },
  { id: '2', content: current, status: 'in_progress' as const },
  { id: '3', content: 'Verify the change', status: 'pending' as const },
];

describe('Slack live task stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sdkGetStreamData.mockResolvedValue(streamData);
    // Model the server: once the data is cleared, later fetches miss.
    mocks.sdkClearStreamData.mockImplementation(async () => {
      mocks.sdkGetStreamData.mockResolvedValue(null);
    });
    mocks.sdkFindFirstInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-test',
    });
    mocks.appendTaskStream.mockResolvedValue({ ok: true });
    mocks.stopTaskStream.mockResolvedValue({ ok: true });
    mocks.updateMessage.mockResolvedValue(true);
  });

  it('puts the generated task title on the card at start', async () => {
    const taskRun = createTaskRun();
    await startSlackLiveTaskStream(taskRun, {});

    expect(mocks.sdkGetStreamData).toHaveBeenCalledWith({ runId: taskRun.id });
    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: {
        id: 'roomote-task-task-1',
        title: 'Fix the button',
        status: 'in_progress',
      },
    });
  });

  it('does not re-send the View task source on updates', async () => {
    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'text', ts: 1000, text: 'First update.' },
      {},
    );

    const task = mocks.appendTaskStream.mock.calls[0]?.[0]?.task;
    expect(task.sources).toBeUndefined();
  });

  it('updates the card for resumed runs through the same run-scoped lookup', async () => {
    const resumed = createTaskRun({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: 42, liveTaskStream: true },
    });

    await updateSlackLiveTaskStream(
      resumed,
      { type: 'text', ts: 1000, text: 'Resumed update.' },
      {},
    );

    expect(mocks.sdkGetStreamData).toHaveBeenCalledWith({ runId: resumed.id });
    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({ status: 'in_progress' }),
    });
  });

  it('shows the current todo as the title without a step count', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const event = {
      type: 'todo_update' as const,
      ts: 1000,
      todos: todos('Make the change'),
    };

    await updateSlackLiveTaskStream(taskRun, event, context);
    await updateSlackLiveTaskStream(taskRun, event, context);

    expect(mocks.appendTaskStream).toHaveBeenCalledOnce();
    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: {
        id: 'roomote-task-task-1',
        title: 'Make the change',
        status: 'in_progress',
      },
    });
  });

  it('shows only the latest message, replacing the previous one', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'todo_update', ts: 1000, todos: todos('Make the change') },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Wiring the new model into spawning.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Editing the selector metadata.' },
      context,
    );

    const titles = mocks.appendTaskStream.mock.calls.map(
      (call) => call[0].task.title,
    );
    expect(titles).toEqual([
      'Make the change',
      'Wiring the new model into spawning.',
      'Editing the selector metadata.',
    ]);
    for (const call of mocks.appendTaskStream.mock.calls) {
      expect(call[0].task).not.toHaveProperty('output');
      expect(call[0].task).not.toHaveProperty('details');
    }
  });

  it('filters transient status lines and duplicate lines', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Provider error: Bad Gateway' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Retrying now.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Inspecting the registry.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1003, text: 'Inspecting the registry.' },
      context,
    );

    expect(mocks.appendTaskStream).toHaveBeenCalledOnce();
    expect(mocks.appendTaskStream).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ title: 'Inspecting the registry.' }),
      }),
    );
  });

  it('does not expose reasoning events in Slack', async () => {
    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'reasoning', ts: 1000, text: 'private reasoning' },
      {},
    );

    expect(mocks.sdkGetStreamData).not.toHaveBeenCalled();
    expect(mocks.appendTaskStream).not.toHaveBeenCalled();
  });

  it('settles the card with the task title, the output, and clears its state', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Almost there.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1001, text: 'Ready for review.' },
      context,
    );

    expect(mocks.stopTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: {
        id: 'roomote-task-task-1',
        title: 'Fix the button',
        status: 'complete',
        output: '\nReady for review.',
      },
    });
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('marks a canceled run as an error when no completion event settled it', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Canceled, {});

    expect(mocks.stopTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        status: 'error',
        output: '\nTask canceled.',
      }),
    });
  });

  it('keeps the stream open after a failed turn so a later run can continue it', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await finishSlackLiveTaskStream(taskRun, RunStatus.Failed, context);

    expect(mocks.stopTaskStream).not.toHaveBeenCalled();
    expect(mocks.sdkClearStreamData).not.toHaveBeenCalled();
    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: {
        id: 'roomote-task-task-1',
        title: 'The task stopped because of an error.',
        status: 'error',
      },
    });

    // The next run of the task flips the card back to in progress.
    const resumed = createTaskRun({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: taskRun.id, liveTaskStream: true },
    });
    await startSlackLiveTaskStream(resumed, {});
    expect(mocks.appendTaskStream).toHaveBeenLastCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: {
        id: 'roomote-task-task-1',
        title: 'Fix the button',
        status: 'in_progress',
      },
    });
  });

  it('falls back to chat.update once Slack reports the stream is gone', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mocks.appendTaskStream.mockResolvedValueOnce({
      ok: false,
      error: 'message_not_in_streaming_state',
    });

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Still working.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1001, text: 'Ready for review.' },
      context,
    );

    expect(mocks.appendTaskStream).toHaveBeenCalledOnce();
    expect(mocks.stopTaskStream).not.toHaveBeenCalled();
    expect(mocks.updateMessage).toHaveBeenNthCalledWith(1, {
      channel: 'C123',
      ts: 'stream-ts',
      message: expect.objectContaining({
        text: 'Still working.',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining('*Still working.*'),
            }),
          }),
        ]),
      }),
    });
    expect(mocks.updateMessage).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      ts: 'stream-ts',
      message: expect.objectContaining({
        text: 'Fix the button',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({
              text: expect.stringContaining('Ready for review.'),
            }),
          }),
        ]),
      }),
    });
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('does not fall back on transient stream errors', async () => {
    mocks.appendTaskStream.mockResolvedValueOnce({
      ok: false,
      error: 'ratelimited',
    });

    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'text', ts: 1000, text: 'Still working.' },
      {},
    );

    expect(mocks.updateMessage).not.toHaveBeenCalled();
  });

  it('settles a completed run as a fallback when the completion event was lost', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Completed, {});

    expect(mocks.stopTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        status: 'complete',
        output: '\nTask completed.',
      }),
    });
  });

  it('does not settle the completion fallback twice after the real completion', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    expect(mocks.stopTaskStream).toHaveBeenCalledOnce();
  });

  it('retains the stream for idle runs awaiting a resume', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Idle, {});

    expect(mocks.stopTaskStream).not.toHaveBeenCalled();
    expect(mocks.sdkClearStreamData).not.toHaveBeenCalled();
  });

  it('wires callbacks only for runs that opted into a card', async () => {
    expect(
      getSlackLiveTaskStreamRunTaskCallbacks(
        createTaskRun({ payload: { description: 'no card' } }),
      ),
    ).toEqual({});

    const callbacks = getSlackLiveTaskStreamRunTaskCallbacks(createTaskRun());
    expect(callbacks.onStart).toBeTypeOf('function');
    expect(callbacks.onMessage).toBeTypeOf('function');
    expect(callbacks.onExit).toBeTypeOf('function');
  });
});
