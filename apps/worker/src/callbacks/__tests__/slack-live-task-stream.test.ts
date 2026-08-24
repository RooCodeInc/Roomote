const mocks = vi.hoisted(() => ({
  renderCard: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      renderSlackLiveTaskCard: mocks.renderCard,
    },
  },
}));

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/sdk/client';

import {
  finishSlackLiveTaskStream,
  getSlackLiveTaskStreamRunTaskCallbacks,
  reportSlackLiveTaskStatus,
  startSlackLiveTaskStream,
  updateSlackLiveTaskStream,
} from '../slack-live-task-stream';

// The module remembers runs without a card for the process lifetime, so
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

/** The state sent by the N-th (1-based) render request. */
function renderedCard(nth: number) {
  const input = mocks.renderCard.mock.calls[nth - 1]?.[0];
  return input ? { status: input.status, output: input.message } : undefined;
}

describe('Slack live task card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.renderCard.mockResolvedValue({ card: true, updated: true });
  });

  it('asks the control plane to render the card on start', async () => {
    const taskRun = createTaskRun();
    await startSlackLiveTaskStream(taskRun, {});

    expect(mocks.renderCard).toHaveBeenCalledWith({
      runId: taskRun.id,
      status: 'in_progress',
    });
  });

  it('stops rendering once the control plane reports no card for the run', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mocks.renderCard.mockResolvedValue({ card: false, updated: false });

    await startSlackLiveTaskStream(taskRun, context);
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Working.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    expect(mocks.renderCard).toHaveBeenCalledOnce();
  });

  it('mirrors the worker startup statuses on the card', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await reportSlackLiveTaskStatus(taskRun, RunStatus.Preparing, context);
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Spawning, context);
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Connecting, context);
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Running, context);

    expect(mocks.renderCard).toHaveBeenCalledTimes(4);
    expect(mocks.renderCard.mock.calls.map((call) => call[0].message)).toEqual([
      'Preparing the workspace…',
      'Starting the agent…',
      'Connecting to the agent…',
      'Agent started, getting to work…',
    ]);
    expect(renderedCard(1)).toMatchObject({ status: 'in_progress' });
  });

  it('keeps updating after a startup status re-opens a settled card', async () => {
    const taskRun = createTaskRun();
    const context = {};

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'First result.' },
      context,
    );
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Running, context);
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Working again.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Agent started, getting to work…',
    });
    expect(renderedCard(3)).toEqual({
      status: 'in_progress',
      output: 'Working again.',
    });
    expect(renderedCard(4)).toEqual({
      status: 'complete',
      output: 'Task completed.',
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

    expect(mocks.renderCard).toHaveBeenCalledWith({
      runId: resumed.id,
      status: 'in_progress',
      message: 'Resumed update.',
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

    expect(mocks.renderCard).toHaveBeenCalledTimes(2);
    expect(renderedCard(1)).toEqual({
      status: 'in_progress',
      output: 'Wiring the new model into spawning.',
    });
    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Editing the selector metadata.',
    });
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
      output: 'Waiting for your input…',
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

    expect(mocks.renderCard).toHaveBeenCalledOnce();
    expect(renderedCard(1)).toMatchObject({
      output: 'Inspecting the registry.',
    });
  });

  it('does not expose reasoning events in Slack', async () => {
    await updateSlackLiveTaskStream(
      createTaskRun(),
      { type: 'reasoning', ts: 1000, text: 'private reasoning' },
      {},
    );

    expect(mocks.renderCard).not.toHaveBeenCalled();
  });

  it('settles the card with the final output', async () => {
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
      status: 'complete',
      output: 'Ready for review.',
    });
  });

  it('ignores late events once the card settled', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Cleaning up.' },
      context,
    );

    expect(mocks.renderCard).toHaveBeenCalledOnce();
  });

  it('re-opens a settled card when the live session starts a follow-up turn', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'turn_started', ts: 1001 },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Checking the follow-up.' },
      context,
    );

    expect(renderedCard(2)).toMatchObject({
      status: 'in_progress',
      output: undefined,
    });
    expect(renderedCard(3)).toMatchObject({
      status: 'in_progress',
      output: 'Checking the follow-up.',
    });
  });

  it('queues a follow-up reopen behind an in-flight completion render', async () => {
    const taskRun = createTaskRun();
    const context = {};
    let releaseCompletion!: () => void;
    mocks.renderCard.mockImplementationOnce(
      () =>
        new Promise<{ card: boolean; updated: boolean }>((resolve) => {
          releaseCompletion = () => resolve({ card: true, updated: true });
        }),
    );

    const completion = updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await vi.waitFor(() => expect(mocks.renderCard).toHaveBeenCalledOnce());

    const reopen = updateSlackLiveTaskStream(
      taskRun,
      { type: 'turn_started', ts: 1001 },
      context,
    );
    const firstFollowUp = updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Checking the follow-up.' },
      context,
    );

    releaseCompletion();
    await Promise.all([completion, reopen, firstFollowUp]);

    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Checking the follow-up.',
    });

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1003, text: 'Applying the follow-up.' },
      context,
    );
    expect(renderedCard(3)).toEqual({
      status: 'in_progress',
      output: 'Applying the follow-up.',
    });
  });

  it('replays narration that arrives while the queued reopen is rendering', async () => {
    const taskRun = createTaskRun();
    const context = {};
    let releaseCompletion!: () => void;
    let releaseReopen!: () => void;
    mocks.renderCard
      .mockImplementationOnce(
        () =>
          new Promise<{ card: boolean; updated: boolean }>((resolve) => {
            releaseCompletion = () => resolve({ card: true, updated: true });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ card: boolean; updated: boolean }>((resolve) => {
            releaseReopen = () => resolve({ card: true, updated: true });
          }),
      );

    const completion = updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await vi.waitFor(() => expect(mocks.renderCard).toHaveBeenCalledOnce());

    const reopen = updateSlackLiveTaskStream(
      taskRun,
      { type: 'turn_started', ts: 1001 },
      context,
    );
    releaseCompletion();
    await vi.waitFor(() => expect(mocks.renderCard).toHaveBeenCalledTimes(2));

    const narration = updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Checking the follow-up.' },
      context,
    );
    releaseReopen();
    await Promise.all([completion, reopen, narration]);

    expect(renderedCard(3)).toEqual({
      status: 'in_progress',
      output: 'Checking the follow-up.',
    });
  });

  it('re-opens a settled card when the agent asks for follow-up input', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'followup',
        ts: 1001,
        question: 'Which option?',
        suggestions: ['One', 'Two'],
      },
      context,
    );

    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Waiting for your input…',
    });
  });

  it('does not settle completion over agent input that arrives during rendering', async () => {
    const taskRun = createTaskRun();
    const context = {};
    let releaseCompletion!: () => void;
    mocks.renderCard.mockImplementationOnce(
      () =>
        new Promise<{ card: boolean; updated: boolean }>((resolve) => {
          releaseCompletion = () => resolve({ card: true, updated: true });
        }),
    );

    const completion = updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await vi.waitFor(() => expect(mocks.renderCard).toHaveBeenCalledOnce());
    const followup = updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'followup',
        ts: 1001,
        question: 'Which option?',
        suggestions: ['One', 'Two'],
      },
      context,
    );
    releaseCompletion();
    await Promise.all([completion, followup]);

    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Waiting for your input…',
    });
  });

  it('does not let completed exit overwrite pending agent input', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'followup',
        ts: 1001,
        question: 'Which option?',
        suggestions: ['One', 'Two'],
      },
      context,
    );

    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    expect(mocks.renderCard).toHaveBeenCalledTimes(2);
    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: 'Waiting for your input…',
    });
  });

  it('re-opens the card when a later run of the task starts', async () => {
    const taskRun = createTaskRun();
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      {},
    );

    const resumed = createTaskRun({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: taskRun.id, liveTaskStream: true },
    });
    await startSlackLiveTaskStream(resumed, {});

    expect(renderedCard(2)).toEqual({
      status: 'in_progress',
      output: undefined,
    });
  });

  it('marks a canceled run as an error', async () => {
    const taskRun = createTaskRun();
    await finishSlackLiveTaskStream(taskRun, RunStatus.Canceled, {});

    expect(renderedCard(1)).toMatchObject({
      status: 'error',
      output: 'Task canceled.',
    });
  });

  it('coalesces a burst of messages into the latest state', async () => {
    const taskRun = createTaskRun();
    const context = {};
    let releaseFirst!: () => void;
    mocks.renderCard.mockImplementationOnce(
      () =>
        new Promise<{ card: boolean; updated: boolean }>((resolve) => {
          releaseFirst = () => resolve({ card: true, updated: true });
        }),
    );

    const first = updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'One.' },
      context,
    );
    // Let the first render reach chat.update before the burst arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const burst = Promise.all([
      updateSlackLiveTaskStream(
        taskRun,
        { type: 'text', ts: 1001, text: 'Two.' },
        context,
      ),
      updateSlackLiveTaskStream(
        taskRun,
        { type: 'text', ts: 1002, text: 'Three.' },
        context,
      ),
    ]);
    releaseFirst();
    await Promise.all([first, burst]);

    // "Two." never went out on its own: the burst collapsed into "Three.".
    expect(mocks.renderCard).toHaveBeenCalledTimes(2);
    expect(renderedCard(1)).toMatchObject({ output: 'One.' });
    expect(renderedCard(2)).toMatchObject({ output: 'Three.' });
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
      output: 'The task stopped because of an error.',
    });

    // The next run of the task flips the card back to in progress.
    const resumed = createTaskRun({
      payloadKind: TaskPayloadKind.SnapshotResume,
      payload: { sourceRunId: taskRun.id, liveTaskStream: true },
    });
    await startSlackLiveTaskStream(resumed, {});
    expect(renderedCard(3)).toEqual({
      status: 'in_progress',
      output: undefined,
    });
  });

  it('retries an identical message after Slack rejects the render', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mocks.renderCard.mockResolvedValueOnce({ card: true, updated: false });

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Inspecting the registry.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1001, text: 'Inspecting the registry.' },
      context,
    );
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1002, text: 'Inspecting the registry.' },
      context,
    );

    // First render rejected, second delivered, third deduplicated.
    expect(mocks.renderCard).toHaveBeenCalledTimes(2);
    expect(renderedCard(2)).toMatchObject({
      output: 'Inspecting the registry.',
    });
  });

  it('retries the settle on exit with the real output when its render was rejected', async () => {
    const taskRun = createTaskRun();
    const context = {};
    mocks.renderCard.mockResolvedValueOnce({ card: true, updated: false });

    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    expect(mocks.renderCard).toHaveBeenCalledTimes(2);
    expect(renderedCard(2)).toMatchObject({
      status: 'complete',
      output: 'Ready for review.',
    });
  });

  it('settles a completed run as a fallback when the completion event was lost', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Running the tests now.' },
      context,
    );
    await finishSlackLiveTaskStream(taskRun, RunStatus.Completed, context);

    // The last narration line is never promoted to the final result.
    expect(renderedCard(2)).toMatchObject({
      status: 'complete',
      output: 'Task completed.',
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

    // The card already settled with the real output, so the fallback is a no-op.
    expect(mocks.renderCard).toHaveBeenCalledOnce();
    expect(renderedCard(1)).toMatchObject({
      output: 'Ready for review.',
    });
  });

  it('settles an idle run as a fallback when the completion event was lost', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'text', ts: 1000, text: 'Running the tests now.' },
      context,
    );
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Idle, context);

    expect(renderedCard(2)).toEqual({
      status: 'complete',
      output: 'Task completed.',
    });
  });

  it('replaces an idle fallback with a delayed real completion', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Idle, context);
    await updateSlackLiveTaskStream(
      taskRun,
      { type: 'completion', ts: 1000, text: 'Ready for review.' },
      context,
    );

    expect(renderedCard(1)).toEqual({
      status: 'complete',
      output: 'Task completed.',
    });
    expect(renderedCard(2)).toEqual({
      status: 'complete',
      output: 'Ready for review.',
    });
  });

  it('keeps an idle card active when the task is waiting for user input', async () => {
    const taskRun = createTaskRun();
    const context = {};
    await updateSlackLiveTaskStream(
      taskRun,
      {
        type: 'followup',
        ts: 1000,
        question: 'Which environment?',
        suggestions: [],
      },
      context,
    );
    await reportSlackLiveTaskStatus(taskRun, RunStatus.Idle, context);

    expect(mocks.renderCard).toHaveBeenCalledOnce();
    expect(renderedCard(1)).toEqual({
      status: 'in_progress',
      output: 'Waiting for your input…',
    });
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
    expect(callbacks.onStatus).toBeTypeOf('function');
  });
});
