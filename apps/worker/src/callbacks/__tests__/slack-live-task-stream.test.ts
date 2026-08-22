const mocks = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  sdkGetStreamData: vi.fn(),
  sdkClearStreamData: vi.fn(),
  sdkFindFirstInstallation: vi.fn(),
}));

vi.mock('@roomote/slack/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack/client')>()),
  SlackNotifier: class {
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

const cardData = {
  channel: 'C123',
  messageTs: 'card-ts',
  taskId: 'task-1',
  taskUpdateId: 'roomote-task-task-1',
  threadTs: '100.001',
  title: 'Fix the button',
  taskUrl: 'https://roomote.example/task/task-1',
};

// The module caches card data per run id for the process lifetime, so
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

const text = (value: string) => ({
  type: 'rich_text',
  elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: value }] },
  ],
});

/** The task_card block of the N-th (1-based) chat.update call. */
function renderedCard(nth: number) {
  const call = mocks.updateMessage.mock.calls[nth - 1]?.[0];
  return call?.message?.blocks?.[0];
}

describe('Slack live task card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sdkGetStreamData.mockResolvedValue(cardData);
    // Model the server: once the data is cleared, later fetches miss.
    mocks.sdkClearStreamData.mockImplementation(async () => {
      mocks.sdkGetStreamData.mockResolvedValue(null);
    });
    mocks.sdkFindFirstInstallation.mockResolvedValue({
      botAccessToken: 'xoxb-test',
    });
    mocks.updateMessage.mockResolvedValue(true);
  });

  it('renders the generated task title on start', async () => {
    const taskRun = createTaskRun();
    await startSlackLiveTaskStream(taskRun, {});

    expect(mocks.sdkGetStreamData).toHaveBeenCalledWith({ runId: taskRun.id });
    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'card-ts',
      message: {
        text: 'Fix the button\n<https://roomote.example/task/task-1|Open the task>',
        blocks: [
          {
            type: 'task_card',
            block_id: 'roomote-task-task-1-card',
            task_id: 'roomote-task-task-1',
            title: 'Fix the button',
            status: 'in_progress',
            sources: [
              {
                type: 'url',
                url: 'https://roomote.example/task/task-1',
                text: 'View task',
              },
            ],
          },
        ],
      },
    });
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
    expect(renderedCard(1)).toMatchObject({
      status: 'in_progress',
      output: text('Resumed update.'),
    });
  });

  it('shows only the latest message, ignoring todo changes', async () => {
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
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'todo_update', ts: 1003, todos: todos('Verify it') },
      context,
    );

    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    expect(renderedCard(1)).toEqual({
      type: 'task_card',
      block_id: 'roomote-task-task-1-card',
      task_id: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'in_progress',
      output: text('Wiring the new model into spawning.'),
      sources: [
        {
          type: 'url',
          url: 'https://roomote.example/task/task-1',
          text: 'View task',
        },
      ],
    });
    expect(renderedCard(2)).toMatchObject({
      output: text('Editing the selector metadata.'),
    });
    expect(renderedCard(2)).not.toHaveProperty('details');
  });

  it('shows a waiting notice while the task needs input', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Need a decision.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'request_user_input', ts: 1001, request: {} } as never,
      context,
    );

    expect(renderedCard(2)).toMatchObject({
      output: text('Waiting for your input…'),
    });
  });

  it('filters transient status lines and duplicate messages', async () => {
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

    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(renderedCard(1)).toMatchObject({
      output: text('Inspecting the registry.'),
    });
  });

  it('does not expose reasoning events in Slack', async () => {
    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'reasoning', ts: 1000, text: 'private reasoning' },
      {},
    );

    expect(mocks.sdkGetStreamData).not.toHaveBeenCalled();
    expect(mocks.updateMessage).not.toHaveBeenCalled();
  });

  it('settles the card with the final output and clears its state', async () => {
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

    expect(renderedCard(2)).toEqual({
      type: 'task_card',
      block_id: 'roomote-task-task-1-card',
      task_id: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'complete',
      output: text('Ready for review.'),
      sources: [
        {
          type: 'url',
          url: 'https://roomote.example/task/task-1',
          text: 'View task',
        },
      ],
    });
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('marks a canceled run as an error and releases the card', async () => {
    const taskRun = createTaskRun();
    await finishSlackLiveTaskStream(taskRun, RunStatus.Canceled, {});

    expect(renderedCard(1)).toMatchObject({
      status: 'error',
      output: text('Task canceled.'),
    });
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('keeps the card alive after a failed turn so the next run continues it', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Working on it.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Failed, context);

    expect(renderedCard(2)).toMatchObject({
      status: 'error',
      output: text('The task stopped because of an error.'),
    });
    expect(mocks.sdkClearStreamData).not.toHaveBeenCalled();

    // The next run of the task flips the card back to in progress.
    const resumed = createTaskRun({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: taskRun.id, liveTaskStream: true },
    });
    await startSlackLiveTaskStream(resumed, {});
    expect(renderedCard(3)).toMatchObject({
      title: 'Fix the button',
      status: 'in_progress',
    });
    expect(renderedCard(3)).not.toHaveProperty('output');
  });

  it('does not release the card when the settling update fails', async () => {
    mocks.updateMessage.mockResolvedValueOnce(false);

    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      {},
    );

    expect(mocks.sdkClearStreamData).not.toHaveBeenCalled();
  });

  it('settles a completed run as a fallback when the completion event was lost', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Completed, {});

    expect(renderedCard(1)).toMatchObject({
      status: 'complete',
      output: text('Task completed.'),
    });
  });

  it('keeps the real output when the completion fallback follows the real completion', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    // The data was cleared by the first settle, so the fallback is a no-op.
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(renderedCard(1)).toMatchObject({
      output: text('Ready for review.'),
    });
  });

  it('retains the card for idle runs awaiting a resume', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Idle, {});

    expect(mocks.updateMessage).not.toHaveBeenCalled();
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
