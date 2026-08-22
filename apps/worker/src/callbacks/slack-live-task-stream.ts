import { RunStatus } from '@roomote/types';
import {
  buildSlackLiveTaskCardBlocks,
  SLACK_TASK_STREAM_GONE_ERRORS,
  SlackNotifier,
  type SlackLiveTaskStreamData,
  type SlackTaskStreamResult,
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

const WAITING_FOR_INPUT_TITLE = 'Waiting for your input…';
const CONTINUING_TITLE = 'Continuing with your answer…';
const WRAPPING_UP_TITLE = 'Wrapping up…';
const FAILED_TURN_TITLE = 'The task stopped because of an error.';

function usesSlackLiveTaskStream(taskRun: TaskRun): boolean {
  return (
    taskRun.payload !== null &&
    typeof taskRun.payload === 'object' &&
    'liveTaskStream' in taskRun.payload &&
    taskRun.payload.liveTaskStream === true
  );
}

/**
 * The card is a single entry that shows ONE line at a time: `title` is the
 * only task_update field Slack replaces on append (details/output/sources
 * accumulate), so the latest progress line (current step, narration, or
 * waiting state) lives there and each update swaps the previous one out.
 * Nothing is written to the body until the card settles, when the title
 * returns to the task title and `output` carries the final result once.
 * The 'View task' source is sent once by the launcher.
 */
function buildCardUpdate(
  data: SlackLiveTaskStreamData,
  status: SlackTaskStreamStatus,
  content: { title?: string; output?: string },
) {
  return {
    id: data.taskUpdateId,
    title: content.title ?? data.title,
    status,
    ...(content.output ? { output: content.output } : {}),
  };
}

type CardState = {
  title?: string;
  status?: SlackTaskStreamStatus;
};

function getCardState(context: RunTaskContext): CardState {
  const existing = context.slackLiveTaskCard;
  return existing && typeof existing === 'object'
    ? (existing as CardState)
    : {};
}

function setCardState(context: RunTaskContext, state: CardState): void {
  context.slackLiveTaskCard = state;
}

/** Set once Slack reports the stream is gone; later changes go through
 * chat.update on the same message instead of the stream API. */
function isStreamGone(context: RunTaskContext): boolean {
  return context.slackLiveTaskStreamGone === true;
}

function markStreamGone(context: RunTaskContext): void {
  context.slackLiveTaskStreamGone = true;
}

async function enqueueStreamUpdate(
  runId: number,
  update: () => Promise<void>,
): Promise<void> {
  const previous = updateQueues.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(update);
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

// The stream data is written once per task by the launcher; the worker reads
// it through the platform API (control-plane Redis is unreachable from the
// sandbox) and caches per run for the process lifetime.
const streamDataCache = new Map<
  number,
  Promise<SlackLiveTaskStreamData | null>
>();

function resolveStreamData(
  taskRun: TaskRun,
): Promise<SlackLiveTaskStreamData | null> {
  const cached = streamDataCache.get(taskRun.id);
  if (cached) {
    return cached;
  }

  const lookup = sdk.taskRuns
    .getSlackLiveTaskStreamData({ runId: taskRun.id })
    .catch((error) => {
      // Do not cache transport failures; the next event retries.
      streamDataCache.delete(taskRun.id);
      throw error;
    });
  streamDataCache.set(taskRun.id, lookup);
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
 * Deliver one card state to Slack. The native stream is preferred; once it
 * reports the message is no longer streaming (expired server-side, or
 * already stopped by an earlier run of this task), the same message is
 * rewritten through chat.update so the card never freezes mid-task.
 */
async function deliverCard(params: {
  context: RunTaskContext;
  data: SlackLiveTaskStreamData;
  status: SlackTaskStreamStatus;
  title: string;
  output?: string;
  settle: boolean;
}): Promise<boolean> {
  const notifier = await getSlackNotifier();
  const fallback = async (): Promise<boolean> =>
    notifier.updateMessage({
      channel: params.data.channel,
      ts: params.data.messageTs,
      message: buildSlackLiveTaskCardBlocks({
        title: params.title,
        status: params.status,
        ...(params.output ? { message: params.output } : {}),
        ...(params.data.taskUrl ? { taskUrl: params.data.taskUrl } : {}),
      }),
    });

  if (isStreamGone(params.context)) {
    return fallback();
  }

  const request = {
    channel: params.data.channel,
    messageTs: params.data.messageTs,
    task: buildCardUpdate(params.data, params.status, {
      title: params.title,
      ...(params.output ? { output: `\n${params.output}` } : {}),
    }),
  };
  const result: SlackTaskStreamResult = params.settle
    ? await notifier.stopTaskStream(request)
    : await notifier.appendTaskStream(request);

  if (result.ok) {
    return true;
  }
  if (result.error && SLACK_TASK_STREAM_GONE_ERRORS.has(result.error)) {
    markStreamGone(params.context);
    return fallback();
  }
  return false;
}

/** Replace the card's single progress line (and status) in place. */
async function updateCard(params: {
  taskRun: TaskRun;
  context: RunTaskContext;
  title: string;
  status?: Extract<SlackTaskStreamStatus, 'in_progress' | 'error'>;
}): Promise<void> {
  const status = params.status ?? 'in_progress';
  const title = params.title.trim();
  const current = getCardState(params.context);

  if (!title || (current.title === title && current.status === status)) {
    return;
  }
  setCardState(params.context, { title, status });

  await enqueueStreamUpdate(params.taskRun.id, async () => {
    const data = await resolveStreamData(params.taskRun);
    if (!data) {
      return;
    }

    await deliverCard({
      context: params.context,
      data,
      status,
      title,
      settle: false,
    });
  });
}

/** Settle the card: task title back on top, final output beneath, and the
 * stream data released so no later run can revive it. */
async function settleCard(params: {
  taskRun: TaskRun;
  context: RunTaskContext;
  status: Extract<SlackTaskStreamStatus, 'complete' | 'error'>;
  output: string;
}): Promise<void> {
  await enqueueStreamUpdate(params.taskRun.id, async () => {
    // Fetch fresh data for the final state so the settled card carries the
    // task's latest generated title.
    streamDataCache.delete(params.taskRun.id);
    const data = await resolveStreamData(params.taskRun);
    if (!data) {
      return;
    }

    const delivered = await deliverCard({
      context: params.context,
      data,
      status: params.status,
      title: data.title,
      output: params.output,
      settle: true,
    });

    if (delivered) {
      setCardState(params.context, {
        title: data.title,
        status: params.status,
      });
      await sdk.taskRuns.clearSlackLiveTaskStreamData({
        runId: params.taskRun.id,
      });
      streamDataCache.set(params.taskRun.id, Promise.resolve(null));
    }
  });
}

export async function startSlackLiveTaskStream(
  taskRun: TaskRun,
  context: RunTaskContext,
): Promise<void> {
  // The launcher opened the card with the prompt; the run-scoped lookup
  // already substitutes the generated task title, so put that on the card
  // right away (a resumed run after a failed turn also flips it back from
  // error to in_progress here).
  const data = await resolveStreamData(taskRun);
  if (!data) {
    return;
  }
  await updateCard({ taskRun, context, title: data.title });
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

  if (event.type === 'completion') {
    await settleCard({
      taskRun,
      context,
      status: 'complete',
      output: event.text,
    });
    return;
  }

  if (event.type === 'text') {
    // Transient status lines (provider retries) never reach the card.
    if (TRANSIENT_NARRATION_PATTERN.test(event.text.trim())) {
      return;
    }
    await updateCard({ taskRun, context, title: event.text });
    return;
  }

  if (event.type === 'todo_update') {
    const current =
      event.todos.find((todo) => todo.status === 'in_progress') ??
      event.todos.find((todo) => todo.status === 'pending');

    await updateCard({
      taskRun,
      context,
      title: current ? current.content : WRAPPING_UP_TITLE,
    });
    return;
  }

  if (event.type === 'request_user_input' || event.type === 'followup') {
    await updateCard({ taskRun, context, title: WAITING_FOR_INPUT_TITLE });
    return;
  }

  if (event.type === 'request_user_input_response') {
    await updateCard({ taskRun, context, title: CONTINUING_TITLE });
  }
}

export async function finishSlackLiveTaskStream(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext,
): Promise<void> {
  // Idle runs retain the stream for a later resume.
  if (status === RunStatus.Idle) {
    return;
  }

  if (status === RunStatus.Completed) {
    // Usually a no-op: the completion CallbackEvent already settled the
    // stream (and cleared its data) with the real output. This fallback
    // guarantees the card cannot stay spinning when that event is lost or
    // its single Slack call failed.
    await settleCard({
      taskRun,
      context,
      status: 'complete',
      output: 'Task completed.',
    });
    return;
  }

  if (status === RunStatus.Canceled) {
    await settleCard({
      taskRun,
      context,
      status: 'error',
      output: 'Task canceled.',
    });
    return;
  }

  // A failed turn is not the end of the task: the workspace is retained and
  // the next run (a follow-up or a retry) keeps driving this same card. Show
  // the failure without settling the stream or releasing its data.
  await updateCard({
    taskRun,
    context,
    title: FAILED_TURN_TITLE,
    status: 'error',
  });
}

function reportStreamCallbackError(
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
        reportStreamCallbackError(error, 'slackLiveTaskStream.onStart', run.id);
      }
    },
    onMessage: async (run, _taskId, event, context) => {
      try {
        await updateSlackLiveTaskStream(run, event, context);
      } catch (error) {
        reportStreamCallbackError(
          error,
          'slackLiveTaskStream.onMessage',
          run.id,
        );
      }
    },
    onExit: async (run, status, context) => {
      try {
        await finishSlackLiveTaskStream(run, status, context);
      } catch (error) {
        reportStreamCallbackError(error, 'slackLiveTaskStream.onExit', run.id);
      }
    },
  };
}
