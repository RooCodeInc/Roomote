import { RunStatus } from '@roomote/types';
import {
  SLACK_SESSION_LIVE_TASK_CARD_MESSAGES,
  type SlackTaskStreamStatus,
} from '@roomote/slack/client';
import { sdk, type TaskRun } from '@roomote/sdk/client';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';
import { isEligibleProvisionalCompletionText } from '../run-task/provisional-completion';
import { captureWorkerException } from '../monitoring/sentry';
import { getCallbackEventKey } from './utils';

const updateQueues = new Map<number, Promise<void>>();

/** Startup progress shown while the sandbox comes up, mirroring the web
 * launcher's booting steps (the controller-side Pending/Dequeued stretch is
 * covered by the launcher's "Starting task…" placeholder). */
const STARTUP_STATUS_MESSAGES: Partial<Record<RunStatus, string>> = {
  [RunStatus.Preparing]: 'Preparing the workspace…',
  [RunStatus.Spawning]: 'Starting the task…',
  [RunStatus.Connecting]: 'Connecting to the task…',
  [RunStatus.Running]: 'Task started, getting to work…',
};

const WAITING_FOR_INPUT_MESSAGE = 'Waiting for your input…';
const CONTINUING_MESSAGE = 'Continuing with your answer…';

function usesSlackLiveTaskStream(taskRun: TaskRun): boolean {
  return (
    taskRun.payload !== null &&
    typeof taskRun.payload === 'object' &&
    'liveTaskStream' in taskRun.payload &&
    taskRun.payload.liveTaskStream === true
  );
}

/**
 * The card's full current state. Every change re-renders the whole
 * `task_card` block through chat.update, so the card shows exactly the
 * LATEST agent message; nothing accumulates, and transient states vanish
 * on the next render.
 */
type SlackLiveTaskCardState = {
  status: Extract<SlackTaskStreamStatus, 'in_progress' | 'complete' | 'error'>;
  /** Latest narration from the agent, or a transient status notice. */
  message?: string;
  /** The completion text, kept apart from narration so the exit fallback
   * never promotes a transient line to the final result. */
  finalMessage?: string;
  /** Prevents the completed-exit fallback from overwriting a prompt that
   * still needs the user's response. */
  awaitingInput?: boolean;
  /** Set once a settling render was delivered; later events are ignored. */
  settled?: boolean;
  /** The idle transition inferred completion before the authoritative
   * turn-completed event arrived. */
  provisionalCompletion?: boolean;
};

/** What the next render must do; merged across coalesced requests. */
type PendingRender = { settle: boolean };

function getCardState(context: RunTaskContext): SlackLiveTaskCardState {
  const existing = context.slackLiveTaskCardState;
  if (existing && typeof existing === 'object') {
    return existing as SlackLiveTaskCardState;
  }

  const next: SlackLiveTaskCardState = { status: 'in_progress' };
  context.slackLiveTaskCardState = next;
  return next;
}

/** The state Slack last confirmed, recorded only after a successful
 * chat.update so a rejected render never suppresses the retry: the next
 * event re-renders the full desired state and is compared against what
 * was actually delivered. */
function getDeliveredCardState(
  context: RunTaskContext,
): SlackLiveTaskCardState | undefined {
  const delivered = context.slackLiveTaskCardDelivered;
  return delivered && typeof delivered === 'object'
    ? (delivered as SlackLiveTaskCardState)
    : undefined;
}

function isSameCardState(
  a: SlackLiveTaskCardState | undefined,
  b: SlackLiveTaskCardState,
): boolean {
  return (
    a !== undefined &&
    a.status === b.status &&
    (a.message ?? '') === (b.message ?? '') &&
    (a.finalMessage ?? '') === (b.finalMessage ?? '') &&
    a.provisionalCompletion === b.provisionalCompletion
  );
}

async function enqueueCardRender(
  runId: number,
  render: () => Promise<void>,
): Promise<void> {
  const previous = updateQueues.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(render);
  updateQueues.set(runId, next);

  try {
    await next;
  } finally {
    if (updateQueues.get(runId) === next) {
      updateQueues.delete(runId);
    }
  }
}

function shouldProcessEvent(
  event: CallbackEvent,
  context: RunTaskContext,
): boolean {
  // Match the Linear agent callback semantics (linear-agent.ts): ignore
  // older events, allow distinct same-timestamp events, and suppress
  // exact duplicates.
  const lastProcessedTs =
    (context.slackLiveTaskLastProcessedTs as number | undefined) ?? 0;

  if (event.ts < lastProcessedTs) {
    return false;
  }

  const processedEventKeys =
    (context.slackLiveTaskProcessedEventKeys as Set<string> | undefined) ??
    new Set<string>();
  context.slackLiveTaskProcessedEventKeys = processedEventKeys;

  if (event.ts > lastProcessedTs) {
    context.slackLiveTaskLastProcessedTs = event.ts;
    processedEventKeys.clear();
  }

  const eventKey = getCallbackEventKey(event);
  if (processedEventKeys.has(eventKey)) {
    return false;
  }

  processedEventKeys.add(eventKey);
  return true;
}

// Runs whose task has no card (or whose workspace is no longer installed):
// every later render would be a wasted round-trip.
const runsWithoutCard = new Set<number>();

/**
 * Render the card's latest state. Requests coalesce: while one render is in
 * flight, any number of further state changes collapse into a single
 * follow-up render of whatever the state is by then, so a burst of agent
 * messages never queues a stale update behind a newer one and never
 * multiplies calls against Slack's rate limit.
 *
 * The render itself happens on the control plane: the worker only sends the
 * state it wants shown and never holds the workspace's bot token. The card
 * data is never released: a follow-up run of the task (after a completion
 * or a failure) re-opens the same card.
 */
async function renderCard(
  taskRun: TaskRun,
  context: RunTaskContext,
  options: { settle?: boolean } = {},
): Promise<void> {
  if (runsWithoutCard.has(taskRun.id)) {
    return;
  }

  const pending = (context.slackLiveTaskPendingRender as
    | PendingRender
    | undefined) ?? { settle: false };
  // Coalescing follows the latest state transition. An interaction event that
  // follows completion must cancel a pending settle rather than inherit it.
  pending.settle = options.settle === true;
  context.slackLiveTaskPendingRender = pending;

  await enqueueCardRender(taskRun.id, async () => {
    const request = context.slackLiveTaskPendingRender as
      | PendingRender
      | undefined;
    if (!request) {
      // An earlier queued render already delivered this state.
      return;
    }
    context.slackLiveTaskPendingRender = undefined;

    const state = { ...getCardState(context) };

    // Nothing new since the last confirmed render. Settling renders retry
    // until confirmed, then queued duplicates collapse.
    const deliveredState = getDeliveredCardState(context);
    if (
      isSameCardState(deliveredState, state) &&
      (!request.settle || getCardState(context).settled === true)
    ) {
      return;
    }

    const result = await sdk.taskRuns.renderSlackLiveTaskCard({
      runId: taskRun.id,
      status: state.status,
      ...(state.status !== 'error' && state.message
        ? { details: state.message }
        : {}),
      ...(state.status === 'error' && state.message
        ? { output: state.message }
        : state.status === 'complete' &&
            state.finalMessage &&
            !state.provisionalCompletion
          ? { output: state.finalMessage }
          : {}),
    });

    if (!result.card) {
      runsWithoutCard.add(taskRun.id);
      return;
    }
    if (!result.updated) {
      return;
    }
    context.slackLiveTaskCardDelivered = state;
    if (request.settle && isSameCardState(getCardState(context), state)) {
      getCardState(context).settled = true;
    }
  });
}

export async function reportSlackLiveTaskStatus(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext,
): Promise<void> {
  if (status === RunStatus.Idle) {
    await finishSlackLiveTaskStream(taskRun, status, context);
    return;
  }

  const message = STARTUP_STATUS_MESSAGES[status];
  if (!message) {
    return;
  }

  const state = getCardState(context);
  if (state.status === 'error') {
    return;
  }
  state.status = 'in_progress';
  state.finalMessage = undefined;
  state.awaitingInput = false;
  state.settled = false;
  state.provisionalCompletion = false;
  state.message = message;
  await renderCard(taskRun, context);
}

export async function startSlackLiveTaskStream(
  taskRun: TaskRun,
  context: RunTaskContext,
): Promise<void> {
  // The launcher posted the card with the prompt; the control plane renders
  // the generated task title from here on, so render right away. A run
  // resumed after a settled turn also flips the card back to in progress.
  const state = getCardState(context);
  if (state.status === 'error') {
    return;
  }
  state.status = 'in_progress';
  state.settled = false;
  state.awaitingInput = false;
  state.provisionalCompletion = false;
  await renderCard(taskRun, context);
}

export async function updateSlackLiveTaskStream(
  taskRun: TaskRun,
  event: CallbackEvent,
  context: RunTaskContext,
): Promise<void> {
  const state = getCardState(context);

  if (event.type === 'turn_started') {
    if (state.status === 'error' || !shouldProcessEvent(event, context)) {
      return;
    }
    if (!state.settled && state.status !== 'complete') {
      return;
    }

    state.status = 'in_progress';
    state.message = undefined;
    state.finalMessage = undefined;
    state.settled = false;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context);
    return;
  }

  // Internal reasoning is deliberately not exposed in Slack; the card
  // gets the safe semantic event stream without chain-of-thought content.
  if (event.type === 'reasoning' || !shouldProcessEvent(event, context)) {
    return;
  }

  if (state.status === 'error') {
    return;
  }

  if (state.settled) {
    // Idle settlement may use the latest finalized assistant message before
    // the authoritative completion callback arrives. Let only that callback
    // replace a provisional or generic result; terminal errors and real final
    // output remain immutable.
    if (
      event.type === 'completion' &&
      event.provisional !== true &&
      state.status === 'complete' &&
      (state.provisionalCompletion === true || state.finalMessage === undefined)
    ) {
      state.settled = false;
    } else if (
      event.type !== 'followup' &&
      event.type !== 'request_user_input' &&
      event.type !== 'request_user_input_response'
    ) {
      return;
    } else {
      state.settled = false;
    }
  }

  if (event.type === 'completion') {
    state.status = 'complete';
    state.awaitingInput = false;
    state.finalMessage = event.text;
    if (event.provisional === true) {
      state.message = event.text;
    }
    state.provisionalCompletion = event.provisional === true;
    await renderCard(taskRun, context, { settle: true });
    return;
  }

  if (event.type === 'text') {
    const text = event.text.trim();
    // Transient status lines (provider retries) never reach the card.
    if (!isEligibleProvisionalCompletionText(text)) {
      return;
    }
    state.status = 'in_progress';
    state.awaitingInput = false;
    state.message = text;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context);
    return;
  }

  // Todo changes are deliberately not shown: the latest message already
  // says what the agent is doing, and a step line on top added noise.

  if (event.type === 'request_user_input' || event.type === 'followup') {
    state.status = 'in_progress';
    state.awaitingInput = true;
    state.message = WAITING_FOR_INPUT_MESSAGE;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context);
    return;
  }

  if (event.type === 'request_user_input_response') {
    state.status = 'in_progress';
    state.awaitingInput = false;
    state.finalMessage = undefined;
    state.message = CONTINUING_MESSAGE;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context);
  }
}

export async function finishSlackLiveTaskStream(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext,
): Promise<void> {
  const state = getCardState(context);

  if (state.status === 'error') {
    if (!state.settled) {
      await renderCard(taskRun, context, { settle: true });
    }
    return;
  }

  if (status === RunStatus.Idle) {
    if (state.settled) {
      return;
    }
    state.status = 'complete';
    if (!state.awaitingInput) {
      state.message =
        state.finalMessage ?? SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.completed;
      state.provisionalCompletion = state.finalMessage === undefined;
    }
    await renderCard(taskRun, context, { settle: true });
    return;
  }

  if (status === RunStatus.Completed) {
    // Usually a no-op: the completion CallbackEvent already settled the
    // card with the real output. This fallback guarantees the card cannot
    // stay spinning when that event is lost, rejected, or the resumable run
    // first settles as idle. Never promote narration to the final result or
    // overwrite a card that is genuinely waiting for user input.
    if (state.settled || state.awaitingInput) {
      return;
    }
    state.status = 'complete';
    state.message =
      state.finalMessage ?? SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.completed;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context, { settle: true });
    return;
  }

  if (status === RunStatus.Canceled) {
    state.status = 'error';
    state.message = SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.canceled;
    state.provisionalCompletion = false;
    await renderCard(taskRun, context, { settle: true });
    return;
  }

  // A failed turn is not the end of the task: the workspace is retained and
  // the next run (a follow-up or a retry) keeps driving this same card.
  state.status = 'error';
  state.message = SLACK_SESSION_LIVE_TASK_CARD_MESSAGES.failed;
  state.provisionalCompletion = false;
  await renderCard(taskRun, context, { settle: true });
}

function reportCardCallbackError(
  error: unknown,
  stage: string,
  runId: number,
): void {
  captureWorkerException(error, { runId, stage });
}

/**
 * Card updates for any run whose payload opted into liveTaskStream,
 * independent of payload kind: Fast children run as StandardTask and
 * resumes run as SnapshotResume, and all of them own a card.
 *
 * Start, status, and message renders are detached: they sit on the
 * worker's startup path and the harness event hot path, and a slow or
 * rate-limited Slack must never hold the run back. Ordering is preserved by
 * the per-run render queue, and `onExit` awaits it so the settling render
 * lands before the worker exits.
 */
export function getSlackLiveTaskStreamRunTaskCallbacks(
  taskRun: TaskRun,
): RunTaskCallbacks {
  if (!usesSlackLiveTaskStream(taskRun)) {
    return {};
  }

  return {
    onStart: async (run, _taskId, context) => {
      void startSlackLiveTaskStream(run, context).catch((error) =>
        reportCardCallbackError(error, 'slackLiveTaskStream.onStart', run.id),
      );
    },
    onMessage: async (run, _taskId, event, context) => {
      void updateSlackLiveTaskStream(run, event, context).catch((error) =>
        reportCardCallbackError(error, 'slackLiveTaskStream.onMessage', run.id),
      );
    },
    onExit: async (run, status, context) => {
      try {
        await finishSlackLiveTaskStream(run, status, context);
      } catch (error) {
        reportCardCallbackError(error, 'slackLiveTaskStream.onExit', run.id);
      }
    },
    onStatus: async (run, status, context) => {
      const update = reportSlackLiveTaskStatus(run, status, context).catch(
        (error) =>
          reportCardCallbackError(
            error,
            'slackLiveTaskStream.onStatus',
            run.id,
          ),
      );
      if (status === RunStatus.Idle) {
        await update;
      }
    },
  };
}
