import { RunStatus } from '@roomote/types';
import {
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

function usesSlackLiveTaskStream(taskRun: TaskRun): boolean {
  return (
    taskRun.payload !== null &&
    typeof taskRun.payload === 'object' &&
    'liveTaskStream' in taskRun.payload &&
    taskRun.payload.liveTaskStream === true
  );
}

/** One card entry. `title` is the only replaceable text slot, so it carries
 * the CURRENT step (todo) and swaps cleanly on every change — no history,
 * just the latest step; on settle it returns to the task title. `output`
 * accumulates the narrative beneath it as newline-prefixed deltas. The
 * 'View task' source is sent once by the launcher (Slack appends sources
 * and details instead of replacing them). */
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

/** The card's current (rotating) title, so narrative appends don't reset it
 * back to the task title between todo changes. */
function getCardTitle(context: RunTaskContext): string | undefined {
  const existing = context.slackLiveTaskCardTitle;
  return typeof existing === 'string' && existing ? existing : undefined;
}

function setCardTitle(context: RunTaskContext, title: string): void {
  context.slackLiveTaskCardTitle = title;
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

async function appendCardUpdate(params: {
  taskRun: TaskRun;
  context: RunTaskContext;
  /** Replaces the entry title (the current step). */
  title?: string;
  /** Appended to the entry's output body as a newline-prefixed delta. */
  output?: string;
}): Promise<void> {
  const outputLine = params.output?.trim();
  const title = params.title ?? getCardTitle(params.context);

  if (params.title && params.title !== getCardTitle(params.context)) {
    // A new step opens a fresh narration budget for the body.
    params.context.slackLiveTaskStepNarrated = false;
  }

  // Skip no-op updates: nothing new to append and the title is unchanged.
  if (
    !outputLine &&
    (!params.title || getCardTitle(params.context) === params.title)
  ) {
    return;
  }
  if (outputLine && params.context.slackLiveTaskLastOutput === outputLine) {
    return;
  }

  if (params.title) {
    setCardTitle(params.context, params.title);
  }
  if (outputLine) {
    params.context.slackLiveTaskLastOutput = outputLine;
  }

  await enqueueStreamUpdate(params.taskRun.id, async () => {
    const data = await resolveStreamData(params.taskRun);
    if (!data) {
      return;
    }

    const notifier = await getSlackNotifier();
    await notifier.appendTaskStream({
      channel: data.channel,
      messageTs: data.messageTs,
      task: buildCardUpdate(data, 'in_progress', {
        ...(title ? { title } : {}),
        ...(outputLine ? { output: `\n${outputLine}` } : {}),
      }),
    });
  });
}

async function stopStream(params: {
  taskRun: TaskRun;
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

    const notifier = await getSlackNotifier();
    const stopped = await notifier.stopTaskStream({
      channel: data.channel,
      messageTs: data.messageTs,
      task: buildCardUpdate(data, params.status, {
        output: `\n${params.output}`,
      }),
    });

    if (stopped) {
      await sdk.taskRuns.clearSlackLiveTaskStreamData({
        runId: params.taskRun.id,
      });
      streamDataCache.set(params.taskRun.id, Promise.resolve(null));
    }
  });
}

export async function startSlackLiveTaskStream(
  taskRun: TaskRun,
): Promise<void> {
  // The card keeps the task title until the first real step arrives; this
  // just warms the stream-data cache so the first event updates instantly.
  await resolveStreamData(taskRun).catch(() => {});
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
    await stopStream({
      taskRun,
      status: 'complete',
      output: event.text,
    });
    return;
  }

  if (event.type === 'text') {
    // Appended body text is permanent, so transient status lines (provider
    // retries) never enter it, and each step contributes at most one
    // narration line to keep the card readable on long runs.
    if (
      TRANSIENT_NARRATION_PATTERN.test(event.text.trim()) ||
      context.slackLiveTaskStepNarrated === true
    ) {
      return;
    }
    context.slackLiveTaskStepNarrated = true;
    await appendCardUpdate({ taskRun, context, output: event.text });
    return;
  }

  if (event.type === 'todo_update') {
    const completedCount = event.todos.filter(
      (todo) => todo.status === 'completed',
    ).length;
    const progress = `${completedCount}/${event.todos.length}`;
    const current =
      event.todos.find((todo) => todo.status === 'in_progress') ??
      event.todos.find((todo) => todo.status === 'pending');

    await appendCardUpdate({
      taskRun,
      context,
      title: current
        ? `${current.content} (${progress})`
        : `${progress} steps complete`,
    });
    return;
  }

  if (event.type === 'request_user_input' || event.type === 'followup') {
    await appendCardUpdate({
      taskRun,
      context,
      title: 'Waiting for your input…',
    });
    return;
  }

  if (event.type === 'request_user_input_response') {
    await appendCardUpdate({
      taskRun,
      context,
      title: 'Continuing with your answer…',
    });
  }
}

export async function finishSlackLiveTaskStream(
  taskRun: TaskRun,
  status: RunStatus,
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
    await stopStream({
      taskRun,
      status: 'complete',
      output: 'Task completed.',
    });
    return;
  }

  await stopStream({
    taskRun,
    status: 'error',
    output:
      status === RunStatus.Canceled
        ? 'Task canceled.'
        : 'The task stopped because of an error.',
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
    onStart: async (run) => {
      try {
        await startSlackLiveTaskStream(run);
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
    onExit: async (run, status) => {
      try {
        await finishSlackLiveTaskStream(run, status);
      } catch (error) {
        reportStreamCallbackError(error, 'slackLiveTaskStream.onExit', run.id);
      }
    },
  };
}
