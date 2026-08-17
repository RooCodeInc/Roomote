const mocks = vi.hoisted(() => ({
  appendTaskStream: vi.fn(),
  stopTaskStream: vi.fn(),
  sdkGetStreamData: vi.fn(),
  sdkClearStreamData: vi.fn(),
  sdkFindFirstInstallation: vi.fn(),
}));

vi.mock('@roomote/slack/client', () => ({
  SlackNotifier: class {
    appendTaskStream = mocks.appendTaskStream;
    stopTaskStream = mocks.stopTaskStream;
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
    mocks.appendTaskStream.mockResolvedValue(true);
    mocks.stopTaskStream.mockResolvedValue(true);
  });

  it('keeps the task title on start, only warming the data cache', async () => {
    const taskRun = createTaskRun();
    await startSlackLiveTaskStream(taskRun);

    expect(mocks.sdkGetStreamData).toHaveBeenCalledWith({ runId: taskRun.id });
    expect(mocks.appendTaskStream).not.toHaveBeenCalled();
  });

  it('does not re-send the View task source on updates', async () => {
    const taskRun = createTaskRun();
    await updateSlackLiveTaskStream(
      taskRun,
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

  it('replaces the entry title with the current todo', async () => {
    const taskRun = createTaskRun();
    const context = {};
    const event = {
      type: 'todo_update' as const,
      ts: 1000,
      todos: [
        { id: '1', content: 'Inspect the code', status: 'completed' as const },
        { id: '2', content: 'Make the change', status: 'in_progress' as const },
        { id: '3', content: 'Verify the change', status: 'pending' as const },
      ],
    };

    await updateSlackLiveTaskStream(taskRun, event, context);
    await updateSlackLiveTaskStream(taskRun, event, context);

    expect(mocks.appendTaskStream).toHaveBeenCalledOnce();
    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        title: 'Make the change (1/3)',
        status: 'in_progress',
      }),
    });
  });

  it('accumulates narrative text into the output body', async () => {
    const taskRun = createTaskRun();
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Wiring the new model into spawning.' },
      {},
    );

    expect(mocks.appendTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        title: 'Fix the button',
        output: '\nWiring the new model into spawning.',
      }),
    });
  });

  it('filters transient status lines and limits narration per step', async () => {
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
      { type: 'text', ts: 1003, text: 'A second narration for this step.' },
      context,
    );

    expect(mocks.appendTaskStream).toHaveBeenCalledOnce();
    expect(mocks.appendTaskStream).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          output: '\nInspecting the registry.',
        }),
      }),
    );

    // A new step reopens the narration budget.
    await updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'todo_update',
        ts: 1004,
        todos: [
          {
            id: '1',
            content: 'Make the change',
            status: 'in_progress' as const,
          },
        ],
      },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1005, text: 'Editing the selector metadata.' },
      context,
    );

    expect(mocks.appendTaskStream).toHaveBeenCalledTimes(3);
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

  it('settles the card with the completion output and clears its state', async () => {
    const taskRun = createTaskRun();
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      {},
    );

    expect(mocks.stopTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        title: 'Fix the button',
        status: 'complete',
        output: '\nReady for review.',
      }),
    });
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('marks a canceled run as an error when no completion event settled it', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Canceled);

    expect(mocks.stopTaskStream).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: 'stream-ts',
      task: expect.objectContaining({
        status: 'error',
        output: '\nTask canceled.',
      }),
    });
  });

  it('settles a completed run as a fallback when the completion event was lost', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Completed);

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
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      {},
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed);

    expect(mocks.stopTaskStream).toHaveBeenCalledOnce();
  });

  it('retains the stream for idle runs awaiting a resume', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Idle);

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
    expect(callbacks.onStart).toBeDefined();
    expect(callbacks.onMessage).toBeDefined();
    expect(callbacks.onExit).toBeDefined();
  });
});
