import {
  buildSelectedTaskSessionUrl,
  buildTelegramLiveTaskMessage,
  type TelegramCommunicationProvider,
} from '@roomote/communication';
import { db, getSessionForTask } from '@roomote/db/server';
import { getRedis } from '@roomote/redis';
import { RunStatus } from '@roomote/types';

import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';

const TELEGRAM_LIVE_TASK_STREAM_TTL_SECONDS = 7 * 24 * 60 * 60;
const TELEGRAM_LIVE_TASK_STREAM_UNAVAILABLE = 'unavailable';
const TRACKING_UNAVAILABLE_MESSAGE =
  'Live updates are unavailable; open Roomote to follow progress.';

export type TelegramLiveTaskStreamProvider = Pick<
  TelegramCommunicationProvider,
  'postMessage' | 'editMessageText'
>;

interface TelegramLiveTaskStreamData {
  channelId: string;
  messageId: string;
  taskId: string;
  threadId?: string;
  taskUrl?: string;
}

interface TelegramLiveTaskRenderResult {
  card: boolean;
  updated: boolean;
}

function getTelegramLiveTaskStreamKey(taskId: string): string {
  return `telegram:live_task_stream:task:${taskId}`;
}

async function getTelegramLiveTaskStreamData(
  taskId: string,
): Promise<TelegramLiveTaskStreamData | false | null> {
  const raw = await getRedis().get(getTelegramLiveTaskStreamKey(taskId));
  if (!raw) return null;
  if (raw === TELEGRAM_LIVE_TASK_STREAM_UNAVAILABLE) return false;

  try {
    const parsed = JSON.parse(raw) as Partial<TelegramLiveTaskStreamData>;
    if (
      typeof parsed.channelId !== 'string' ||
      typeof parsed.messageId !== 'string' ||
      typeof parsed.taskId !== 'string'
    ) {
      return null;
    }
    return parsed as TelegramLiveTaskStreamData;
  } catch {
    return null;
  }
}

async function markTelegramLiveTaskStreamUnavailable(
  taskId: string,
): Promise<void> {
  await getRedis().set(
    getTelegramLiveTaskStreamKey(taskId),
    TELEGRAM_LIVE_TASK_STREAM_UNAVAILABLE,
    'EX',
    TELEGRAM_LIVE_TASK_STREAM_TTL_SECONDS,
  );
}

async function setTelegramLiveTaskStreamData(
  data: TelegramLiveTaskStreamData,
): Promise<void> {
  await getRedis().set(
    getTelegramLiveTaskStreamKey(data.taskId),
    JSON.stringify(data),
    'EX',
    TELEGRAM_LIVE_TASK_STREAM_TTL_SECONDS,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermanentlyUneditable(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes('message to edit not found') ||
    message.includes("message can't be edited") ||
    message.includes('message cannot be edited')
  );
}

export async function startTelegramLiveTaskStream(input: {
  provider: TelegramLiveTaskStreamProvider;
  taskRun: { id: number; taskId: string };
  taskUrl: string;
  channelId: string;
  threadId?: string;
}): Promise<void> {
  let postedMessageId: string | undefined;
  let destinationUrl = input.taskUrl;

  try {
    const linkedSession = await getSessionForTask(db, input.taskRun.taskId);
    destinationUrl = linkedSession
      ? buildSelectedTaskSessionUrl({
          taskUrl: input.taskUrl,
          sessionId: linkedSession.id,
          taskId: input.taskRun.taskId,
        })
      : input.taskUrl;

    if ((await getTelegramLiveTaskStreamData(input.taskRun.taskId)) !== null) {
      return;
    }

    const message = buildTelegramLiveTaskMessage({
      status: 'running',
      taskUrl: destinationUrl,
    });
    const posted = await input.provider.postMessage({
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...message,
    });
    postedMessageId = posted.messageId;

    await setTelegramLiveTaskStreamData({
      channelId: input.channelId,
      messageId: posted.messageId,
      taskId: input.taskRun.taskId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      taskUrl: destinationUrl,
    });
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to start Telegram live updates for run ${input.taskRun.id}: ${describeError(error)}`,
    );
    if (!postedMessageId) return;

    try {
      await input.provider.editMessageText({
        channelId: input.channelId,
        messageId: postedMessageId,
        ...buildTelegramLiveTaskMessage({
          status: 'failed',
          progress: TRACKING_UNAVAILABLE_MESSAGE,
          taskUrl: destinationUrl,
        }),
      });
    } catch (updateError) {
      console.error(
        `[Fast Agent] Failed to settle untracked Telegram live updates for run ${input.taskRun.id}: ${describeError(updateError)}`,
      );
    }
  }
}

export async function renderTelegramLiveTaskStream(input: {
  taskId: string;
  status: 'in_progress' | 'complete' | 'error';
  details?: string;
  output?: string;
}): Promise<TelegramLiveTaskRenderResult> {
  const data = await getTelegramLiveTaskStreamData(input.taskId);
  if (!data) return { card: false, updated: false };

  // The owning Fast Session posts the successful result. Preserve the live
  // message and its pointer so a resumed run can continue editing it.
  if (input.status === 'complete') {
    return { card: true, updated: true };
  }

  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();
  if (!provider) return { card: false, updated: false };

  try {
    const status =
      input.status === 'in_progress'
        ? input.details?.trim() === 'Waiting for your input…'
          ? 'waiting'
          : 'running'
        : input.output === 'Stopped.'
          ? 'stopped'
          : 'failed';
    await provider.editMessageText({
      channelId: data.channelId,
      messageId: data.messageId,
      ...buildTelegramLiveTaskMessage({
        status,
        // Final output is delivered by the owning Fast Session. The canonical
        // Telegram status message never duplicates that authoritative reply.
        ...((status === 'running' || status === 'waiting') && input.details
          ? { progress: input.details }
          : {}),
        ...(data.taskUrl ? { taskUrl: data.taskUrl } : {}),
      }),
    });
    return { card: true, updated: true };
  } catch (error) {
    console.error(
      `[telegram] Failed to edit live task message for task ${input.taskId}: ${describeError(error)}`,
    );
    if (!isPermanentlyUneditable(error)) {
      return { card: true, updated: false };
    }

    await markTelegramLiveTaskStreamUnavailable(input.taskId).catch(
      (markError) => {
        console.error(
          `[telegram] Failed to mark live task message unavailable for task ${input.taskId}: ${describeError(markError)}`,
        );
      },
    );
    return { card: false, updated: false };
  }
}

export async function settleTelegramLiveTaskStreamForRun(input: {
  taskId: string;
  payload: unknown;
  status: RunStatus.Failed | RunStatus.Canceled;
}): Promise<void> {
  if (
    input.payload === null ||
    typeof input.payload !== 'object' ||
    (input.payload as { liveTaskStream?: unknown }).liveTaskStream !== true
  ) {
    return;
  }

  await renderTelegramLiveTaskStream({
    taskId: input.taskId,
    status: 'error',
    output:
      input.status === RunStatus.Canceled
        ? 'Stopped.'
        : 'Stopped because of an error.',
  }).catch((error) => {
    console.error(
      `[telegram] Failed to settle live task message for task ${input.taskId}: ${describeError(error)}`,
    );
  });
}
