import { RunStatus } from '@roomote/types';
import {
  buildSlackLiveTaskCardBlocks,
  SlackNotifier,
  type SlackLiveTaskStreamData,
  type SlackTaskStreamStatus,
} from '@roomote/slack/client';
import { sdk, type TaskRun } from '@roomote/sdk/client';

import type {
  CallbackEvent,
  RunTaskCallbacks,
  RunTaskContext,
} from '../run-task';
import { captureWorkerException } from '../monitoring/sentry';
import { getCallbackEventKey } from './utils';

const updateQueues = new Map<number, Promise<void>>();

/** Harness status noise that reads as an error but resolves on its own. */
const TRANSIENT_NARRATION_PATTERN = /^(provider error|retrying)\b/i;

/** Startup progress shown while the sandbox comes up, mirroring the web
 * launcher's booting steps (the controller-side Pending/Dequeued stretch is
 * covered by the launcher's "Starting task…" placeholder). */
const STARTUP_STATUS_MESSAGES: Partial<Record<RunStatus, string>> = {
  [RunStatus.Preparing]: 'Preparing the workspace…',
  [RunStatus.Spawning]: 'Starting the agent…',
  [RunStatus.Connecting]: 'Connecting to the agent…',
  [RunStatus.Running]: 'Agent started, getting to work…',
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
  /** Latest narration from the agent (or a waiting notice), or the final
   * result once settled. */
  message?: string;
};

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
    (a.message ?? '') === (b.message ?? '')
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

// The card data is written once per task by the launcher; the worker reads
// it through the platform API (control-plane Redis is unreachable from the
// sandbox) and caches per run for the process lifetime.
const cardDataCache = new Map<
  number,
  Promise<SlackLiveTaskStreamData | null>
>();

function resolveCardData(
  taskRun: TaskRun,
): Promise<SlackLiveTaskStreamData | null> {
  const cached = cardDataCache.get(taskRun.id);
  if (cached) {
    return cached;
  }

  const lookup = sdk.taskRuns
    .getSlackLiveTaskStreamData({ runId: taskRun.id })
    .catch((error) => {
      // Do not cache transport failures; the next event retries.
      cardDataCache.delete(taskRun.id);
      throw error;
    });
  cardDataCache.set(taskRun.id, lookup);
  return lookup;
}

let slack: SlackNotifier | undefined = undefined;

async function getSlackNotifier(): Promise<SlackNotifier> {
  if (!slack) {
    const slackInstallation = await sdk.slackInstallations.findFirst();

    if (!slackInstallation) {
      throw new Error('Slack installation not found.');
    }

    slack = new SlackNotifier(slackInstallation.botAccessToken);
  }

  return slack;
}

/**
 * Re-render the card from its current state. Settled renders (complete, or
 * a terminal error) also release the card data so no later run revives it;
 * a failed turn is rendered as an error but keeps the data, because the
 * workspace is retained and the next run of the task continues this card.
 */
async function renderCard(
  taskRun: TaskRun,
  context: RunTaskContext,
  options: { refreshData?: boolean; settle?: boolean } = {},
): Promise<void> {
  // Snapshot now: later events may mutate the state before this render
  // reaches the front of the queue, and each render must reflect its own
  // moment so the final settled state is never overwritten by a stale one.
  const state = { ...getCardState(context) };

  await enqueueCardRender(taskRun.id, async () => {
    // Nothing new since the last confirmed render. Settling renders always
    // go out: they also release the card data.
    if (
      !options.settle &&
      isSameCardState(getDeliveredCardState(context), state)
    ) {
      return;
    }
    if (options.refreshData) {
      // Fetch fresh data for the final render so the settled card carries
      // the task's latest generated title.
      cardDataCache.delete(taskRun.id);
    }
    const data = await resolveCardData(taskRun);
    if (!data) {
      return;
    }

    const notifier = await getSlackNotifier();
    const updated = await notifier.updateMessage({
      channel: data.channel,
      ts: data.messageTs,
      message: buildSlackLiveTaskCardBlocks({
        taskUpdateId: data.taskUpdateId,
        title: data.title,
        status: state.status,
        ...(state.message ? { message: state.message } : {}),
        ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
      }),
    });

    if (!updated) {
      return;
    }
    context.slackLiveTaskCardDelivered = state;

    if (options.settle) {
      await sdk.taskRuns.clearSlackLiveTaskStreamData({
        runId: taskRun.id,
      });
      cardDataCache.set(taskRun.id, Promise.resolve(null));
    }
  });
}

export async function reportSlackLiveTaskStatus(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext,
): Promise<void> {
  const message = STARTUP_STATUS_MESSAGES[status];
  if (!message) {
    return;
  }

  const state = getCardState(context);
  state.status = 'in_progress';
  state.message = message;
  // The first startup render also swaps the launcher's placeholder title
  // for the generated task title.
  await renderCard(taskRun, context, { refreshData: true });
}

export async function startSlackLiveTaskStream(
  taskRun: TaskRun,
  context: RunTaskContext,
): Promise<void> {
  // The launcher posted the card with the prompt; the run-scoped lookup
  // substitutes the generated task title, so render it right away. A run
  // resumed after a failed turn also flips the card back to in progress.
  const state = getCardState(context);
  state.status = 'in_progress';
  await renderCard(taskRun, context, { refreshData: true });
}

export async function updateSlackLiveTaskStream(
  taskRun: TaskRun,
  event: CallbackEvent,
  context: RunTaskContext,
): Promise<void> {
  // Internal reasoning is deliberately not exposed in Slack; the card
  // gets the safe semantic event stream without chain-of-thought content.
  if (event.type === 'reasoning' || !shouldProcessEvent(event, context)) {
    return;
  }

  const state = getCardState(context);

  if (event.type === 'completion') {
    state.status = 'complete';
    state.message = event.text;
    await renderCard(taskRun, context, { refreshData: true, settle: true });
    return;
  }

  if (event.type === 'text') {
    const text = event.text.trim();
    // Transient status lines (provider retries) never reach the card.
    if (!text || TRANSIENT_NARRATION_PATTERN.test(text)) {
      return;
    }
    state.message = text;
    await renderCard(taskRun, context);
    return;
  }

  // Todo changes are deliberately not shown: the latest message already
  // says what the agent is doing, and a step line on top added noise.

  if (event.type === 'request_user_input' || event.type === 'followup') {
    state.message = WAITING_FOR_INPUT_MESSAGE;
    await renderCard(taskRun, context);
    return;
  }

  if (event.type === 'request_user_input_response') {
    state.message = CONTINUING_MESSAGE;
    await renderCard(taskRun, context);
  }
}

export async function finishSlackLiveTaskStream(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext,
): Promise<void> {
  // Idle runs retain the card for a later resume.
  if (status === RunStatus.Idle) {
    return;
  }

  const state = getCardState(context);

  if (status === RunStatus.Completed) {
    // Usually a no-op: the completion CallbackEvent already settled the
    // card (and cleared its data) with the real output. This fallback
    // guarantees the card cannot stay spinning when that event is lost.
    state.status = 'complete';
    state.message ??= 'Task completed.';
    await renderCard(taskRun, context, { refreshData: true, settle: true });
    return;
  }

  if (status === RunStatus.Canceled) {
    state.status = 'error';
    state.message = 'Task canceled.';
    await renderCard(taskRun, context, { refreshData: true, settle: true });
    return;
  }

  // A failed turn is not the end of the task: the workspace is retained and
  // the next run (a follow-up or a retry) keeps driving this same card, so
  // show the failure without releasing the card data.
  state.status = 'error';
  state.message = 'The task stopped because of an error.';
  await renderCard(taskRun, context);
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
 */
export function getSlackLiveTaskStreamRunTaskCallbacks(
  taskRun: TaskRun,
): RunTaskCallbacks {
  if (!usesSlackLiveTaskStream(taskRun)) {
    return {};
  }

  return {
    onStart: async (run, _taskId, context) => {
      try {
        await startSlackLiveTaskStream(run, context);
      } catch (error) {
        reportCardCallbackError(error, 'slackLiveTaskStream.onStart', run.id);
      }
    },
    onMessage: async (run, _taskId, event, context) => {
      try {
        await updateSlackLiveTaskStream(run, event, context);
      } catch (error) {
        reportCardCallbackError(error, 'slackLiveTaskStream.onMessage', run.id);
      }
    },
    onExit: async (run, status, context) => {
      try {
        await finishSlackLiveTaskStream(run, status, context);
      } catch (error) {
        reportCardCallbackError(error, 'slackLiveTaskStream.onExit', run.id);
      }
    },
    onStatus: async (run, status, context) => {
      try {
        await reportSlackLiveTaskStatus(run, status, context);
      } catch (error) {
        reportCardCallbackError(error, 'slackLiveTaskStream.onStatus', run.id);
      }
    },
  };
}
