import { RunStatus, buildSlackRichTextValue } from '@roomote/types';
import {
  SlackNotifier,
  type SlackLiveTaskStreamData,
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

function usesSlackLiveTaskStream(taskRun: TaskRun): boolean {
  return (
    taskRun.payload !== null &&
    typeof taskRun.payload === 'object' &&
    'liveTaskStream' in taskRun.payload &&
    taskRun.payload.liveTaskStream === true
  );
}

/**
 * The card's full current state. Every update re-renders the whole
 * task_card block via chat.update, so the body always shows just the
 * latest step and narration — transient states (provider retries, waiting
 * notices) vanish on the next render instead of accumulating.
 */
type SlackLiveTaskCardState = {
  status: 'in_progress' | 'complete' | 'error';
  /** Current todo with progress, or a waiting/continuing notice. */
  step?: string;
  /** Latest narrative line from the agent. */
  narration?: string;
  /** Final result text, set when the card settles. */
  output?: string;
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

function buildCardBlocks(
  data: SlackLiveTaskStreamData,
  state: SlackLiveTaskCardState,
) {
  const detailLines = [state.step, state.narration].filter(
    (line): line is string => Boolean(line?.trim()),
  );

  return [
    {
      type: 'task_card' as const,
      task_id: data.taskUpdateId,
      title: data.title,
      status: state.status,
      ...(detailLines.length > 0
        ? { details: buildSlackRichTextValue(detailLines.join('\n')) }
        : {}),
      ...(state.output
        ? { output: buildSlackRichTextValue(state.output) }
        : {}),
      ...(data.taskUrl
        ? {
            sources: [
              { type: 'url' as const, url: data.taskUrl, text: 'View task' },
            ],
          }
        : {}),
    },
  ];
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

// The card data is written once per task by the launcher; the worker reads
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

async function renderCard(
  taskRun: TaskRun,
  context: RunTaskContext,
  options: { refreshData?: boolean } = {},
): Promise<void> {
  const state = getCardState(context);

  await enqueueStreamUpdate(taskRun.id, async () => {
    if (options.refreshData) {
      // Fetch fresh data for the final render so the settled card carries
      // the task's latest generated title.
      streamDataCache.delete(taskRun.id);
    }
    const data = await resolveStreamData(taskRun);
    if (!data) {
      return;
    }

    const notifier = await getSlackNotifier();
    const updated = await notifier.updateMessage({
      channel: data.channel,
      ts: data.messageTs,
      message: {
        text: data.title,
        blocks: buildCardBlocks(data, state),
      },
    });

    if (updated && state.status !== 'in_progress') {
      await sdk.taskRuns.clearSlackLiveTaskStreamData({
        runId: taskRun.id,
      });
      streamDataCache.set(taskRun.id, Promise.resolve(null));
    }
  });
}

export async function startSlackLiveTaskStream(
  taskRun: TaskRun,
): Promise<void> {
  // The card keeps the task title until the first real step arrives; this
  // just warms the card-data cache so the first event renders instantly.
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

  const state = getCardState(context);

  if (event.type === 'completion') {
    state.status = 'complete';
    state.step = undefined;
    state.narration = undefined;
    state.output = event.text;
    await renderCard(taskRun, context, { refreshData: true });
    return;
  }

  if (event.type === 'text') {
    state.narration = event.text;
    await renderCard(taskRun, context);
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

    state.step = current
      ? `${current.content} (${progress})`
      : `${progress} steps complete`;
    await renderCard(taskRun, context);
    return;
  }

  if (event.type === 'request_user_input' || event.type === 'followup') {
    state.step = 'Waiting for your input…';
    await renderCard(taskRun, context);
    return;
  }

  if (event.type === 'request_user_input_response') {
    state.step = 'Continuing with your answer…';
    await renderCard(taskRun, context);
  }
}

export async function finishSlackLiveTaskStream(
  taskRun: TaskRun,
  status: RunStatus,
  context: RunTaskContext = {},
): Promise<void> {
  // Idle runs retain the card for a later resume.
  if (status === RunStatus.Idle) {
    return;
  }

  const state = getCardState(context);
  state.step = undefined;
  state.narration = undefined;

  if (status === RunStatus.Completed) {
    // Usually a no-op render: the completion CallbackEvent already settled
    // the card (and cleared its data) with the real output. This fallback
    // guarantees the card cannot stay spinning when that event is lost.
    state.status = 'complete';
    state.output ??= 'Task completed.';
  } else {
    state.status = 'error';
    state.output =
      status === RunStatus.Canceled
        ? 'Task canceled.'
        : 'The task stopped because of an error.';
  }

  await renderCard(taskRun, context, { refreshData: true });
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
    onExit: async (run, status, context) => {
      try {
        await finishSlackLiveTaskStream(run, status, context);
      } catch (error) {
        reportStreamCallbackError(error, 'slackLiveTaskStream.onExit', run.id);
      }
    },
  };
}
