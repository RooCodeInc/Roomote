const mocks = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  sdkGetStreamData: vi.fn(),
  sdkClearStreamData: vi.fn(),
  sdkFindFirstInstallation: vi.fn(),
}));

vi.mock('@roomote/slack/client', () => ({
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

const streamData = {
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

function lastRenderedCard() {
  const call = mocks.updateMessage.mock.calls.at(-1)?.[0];
  return call?.message?.blocks?.[0];
}

function richTextLines(value: unknown): string[] {
  const sections =
    (value as { elements?: Array<{ elements?: Array<{ text?: string }> }> })
      ?.elements ?? [];
  return sections.map((section) =>
    (section.elements ?? []).map((element) => element.text ?? '').join(''),
  );
}

describe('Slack live task card', () => {
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
    mocks.updateMessage.mockResolvedValue(true);
  });

  it('only warms the card-data cache on start', async () => {
    const taskRun = createTaskRun();
    await startSlackLiveTaskStream(taskRun);

    expect(mocks.sdkGetStreamData).toHaveBeenCalledWith({ runId: taskRun.id });
    expect(mocks.updateMessage).not.toHaveBeenCalled();
  });

  it('re-renders the whole card with the current todo as details', async () => {
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

    expect(mocks.updateMessage).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'card-ts',
      message: expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'task_card',
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
          }),
        ],
      }),
    });
    expect(richTextLines(lastRenderedCard()?.details)).toEqual([
      'Make the change (1/3)',
    ]);
  });

  it('replaces the narration line instead of accumulating it', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Provider error: Bad Gateway' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Wiring the new model into spawning.' },
      context,
    );

    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    expect(richTextLines(lastRenderedCard()?.details)).toEqual([
      'Wiring the new model into spawning.',
    ]);
  });

  it('keeps the step line above the latest narration', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'todo_update',
        ts: 1000,
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
      { type: 'text', ts: 1001, text: 'Editing the selector metadata.' },
      context,
    );

    expect(richTextLines(lastRenderedCard()?.details)).toEqual([
      'Make the change (0/1)',
      'Editing the selector metadata.',
    ]);
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

  it('settles the card with the completion output and clears its state', async () => {
    const taskRun = createTaskRun();
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      {},
    );

    const card = lastRenderedCard();
    expect(card).toEqual(
      expect.objectContaining({
        type: 'task_card',
        title: 'Fix the button',
        status: 'complete',
      }),
    );
    expect(card?.details).toBeUndefined();
    expect(richTextLines(card?.output)).toEqual(['Ready for review.']);
    expect(mocks.sdkClearStreamData).toHaveBeenCalledWith({
      runId: taskRun.id,
    });
  });

  it('marks a canceled run as an error when no completion event settled it', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Canceled);

    const card = lastRenderedCard();
    expect(card).toEqual(
      expect.objectContaining({ type: 'task_card', status: 'error' }),
    );
    expect(richTextLines(card?.output)).toEqual(['Task canceled.']);
  });

  it('settles a completed run as a fallback when the completion event was lost', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Completed);

    const card = lastRenderedCard();
    expect(card).toEqual(
      expect.objectContaining({ type: 'task_card', status: 'complete' }),
    );
    expect(richTextLines(card?.output)).toEqual(['Task completed.']);
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

    expect(mocks.updateMessage).toHaveBeenCalledOnce();
  });

  it('retains the card for idle runs awaiting a resume', async () => {
    await finishSlackLiveTaskStream(createTaskRun(), RunStatus.Idle);

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
    expect(callbacks.onStart).toBeDefined();
    expect(callbacks.onMessage).toBeDefined();
    expect(callbacks.onExit).toBeDefined();
  });
});
