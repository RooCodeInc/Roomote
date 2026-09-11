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
  startedAt: number;
  threadId?: string;
  title: string;
  taskUrl?: string;
}

export interface TelegramLiveTaskRenderResult {
  card: boolean;
  updated: boolean;
}

function getTelegramLiveTaskStreamKey(taskId: string): string {
  return `telegram:live_task_stream:task:${taskId}`;
}

async function getTelegramLiveTaskStreamData(
  taskId: string,
): Promise<TelegramLiveTaskStreamData | null> {
  const raw = await getRedis().get(getTelegramLiveTaskStreamKey(taskId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<TelegramLiveTaskStreamData>;
    if (
      typeof parsed.channelId !== 'string' ||
      typeof parsed.messageId !== 'string' ||
      typeof parsed.taskId !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.title !== 'string'
    ) {
      return null;
    }
    return parsed as TelegramLiveTaskStreamData;
  } catch {
    return null;
  }
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
  prompt: string;
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

    if (await getTelegramLiveTaskStreamData(input.taskRun.taskId)) return;

    const message = buildTelegramLiveTaskMessage({
      title: input.prompt,
      status: 'running',
      elapsedSeconds: 0,
      taskUrl: destinationUrl,
    });
    const posted = await input.provider.postMessage({
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      text: message.text,
      ...(message.buttons ? { buttons: message.buttons } : {}),
    });
    postedMessageId = posted.messageId;

    await setTelegramLiveTaskStreamData({
      channelId: input.channelId,
      messageId: posted.messageId,
      taskId: input.taskRun.taskId,
      startedAt: Date.now(),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      title: input.prompt,
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
          title: input.prompt,
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
  taskTitle?: string | null;
}): Promise<TelegramLiveTaskRenderResult> {
  const data = await getTelegramLiveTaskStreamData(input.taskId);
  if (!data) return { card: false, updated: false };

  const provider =
    await createTelegramCommunicationProviderFromRuntimeCredentials();
  if (!provider) return { card: false, updated: false };

  try {
    const status =
      input.status === 'in_progress'
        ? input.details?.trim() === 'Waiting for your input…'
          ? 'waiting'
          : 'running'
        : input.status === 'complete'
          ? 'completed'
          : input.output === 'Stopped.'
            ? 'stopped'
            : 'failed';
    await provider.editMessageText({
      channelId: data.channelId,
      messageId: data.messageId,
      ...buildTelegramLiveTaskMessage({
        title: input.taskTitle?.trim() || data.title,
        status,
        elapsedSeconds: Math.max(
          0,
          Math.floor((Date.now() - data.startedAt) / 1000),
        ),
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
    return isPermanentlyUneditable(error)
      ? { card: false, updated: false }
      : { card: true, updated: false };
  }
}

export async function settleTelegramLiveTaskStreamForRun(input: {
  taskId: string;
  payload: unknown;
  status: RunStatus.Failed | RunStatus.Canceled;
  taskTitle?: string | null;
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
    taskTitle: input.taskTitle,
  }).catch((error) => {
    console.error(
      `[telegram] Failed to settle live task message for task ${input.taskId}: ${describeError(error)}`,
    );
  });
}
