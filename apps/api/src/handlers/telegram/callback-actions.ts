import type { TelegramCallbackQuery } from '@roomote/communication/telegram-update';
import { activeCloudTaskStatuses } from '@roomote/types';
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  sql,
  taskRuns,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { stopTaskJob } from '../tasks/task-stop.js';
import { resolveTelegramSenderUserId } from './linked-user.js';
import {
  answerTelegramCallbackQueryBestEffort,
  clearTelegramMessageButtonsBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
import {
  claimTelegramSuggestionLaunch,
  parseTelegramSuggestionCallbackData,
} from './setup-suggestions.js';
import { startNewTelegramTask } from './task-orchestration.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';

const CANCEL_TASK_CALLBACK_PREFIX = 'cancel_task:';

/** callback_data is limited to 64 bytes, so carry only the cloud job id. */
export function buildTelegramCancelTaskCallbackData(
  cloudJobId: number,
): string {
  return `${CANCEL_TASK_CALLBACK_PREFIX}${cloudJobId}`;
}

function parseCancelTaskCallbackData(data: string): number | null {
  if (!data.startsWith(CANCEL_TASK_CALLBACK_PREFIX)) {
    return null;
  }

  const cloudJobId = Number.parseInt(
    data.slice(CANCEL_TASK_CALLBACK_PREFIX.length),
    10,
  );

  return Number.isSafeInteger(cloudJobId) && cloudJobId > 0 ? cloudJobId : null;
}

async function findCancelableCloudJob(cloudJobId: number, chatId: string) {
  return db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.id, cloudJobId),
      // Only cancel jobs launched from the chat the button lives in — the
      // inbound message path is chat-scoped the same way.
      sql`${taskRuns.payload}->>'communicationProvider' = 'telegram'`,
      sql`${taskRuns.payload}->>'communicationChannelId' = ${chatId}`,
      inArray(taskRuns.status, [...activeCloudTaskStatuses]),
      isNull(taskRuns.canceledAt),
    ),
    columns: {
      id: true,
      taskId: true,
      status: true,
      sandboxServerUrl: true,
      actingUserId: true,
    },
  });
}

async function handleCancelTaskCallback(params: {
  query: TelegramCallbackQuery;
  cloudJobId: number;
}): Promise<void> {
  const message = params.query.message;
  const chatId = message ? String(message.chat.id) : null;

  // Without the originating message there is no chat to authorize against.
  if (!chatId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
    });
    return;
  }

  const cancelableJob = await findCancelableCloudJob(params.cloudJobId, chatId);

  if (!cancelableJob) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
      text: 'That task is no longer running.',
    });

    if (chatId && message) {
      await clearTelegramMessageButtonsBestEffort({
        chatId,
        messageId: String(message.message_id),
      });
    }

    return;
  }

  const stopResult = await stopTaskJob({
    job: cancelableJob,
    allowDirectCancelWithoutSandbox: true,
  });

  const canceled =
    stopResult.success ||
    // 404/409 mean the job already reached a terminal state.
    stopResult.statusCode === 404 ||
    stopResult.statusCode === 409;

  if (!canceled) {
    apiLogger.warn(
      `[telegram] Failed to cancel cloud job ${params.cloudJobId} from callback: ${JSON.stringify(stopResult)}`,
    );
  }

  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: params.query.id,
    text: canceled ? 'Task canceled.' : 'Could not cancel the task.',
  });

  if (chatId && message) {
    if (canceled) {
      await clearTelegramMessageButtonsBestEffort({
        chatId,
        messageId: String(message.message_id),
      });
    }

    await postTelegramMessageBestEffort({
      chatId,
      replyToMessageId: String(message.message_id),
      text: canceled
        ? 'Canceled the task.'
        : 'Could not cancel the task — check the task page for its current state.',
    });
  }
}

async function handleSuggestionLaunchCallback(params: {
  query: TelegramCallbackQuery;
  suggestionId: string;
}): Promise<void> {
  const message = params.query.message;
  const chatId = message ? String(message.chat.id) : null;

  if (!chatId || !message) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
    });
    return;
  }

  const senderUserId = await resolveTelegramSenderUserId(
    String(params.query.from.id),
  );

  if (!senderUserId) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
      text: 'Link your Roomote account to start tasks from Telegram.',
    });
    return;
  }

  const suggestion = await claimTelegramSuggestionLaunch({
    suggestionId: params.suggestionId,
    chatId,
  });

  if (!suggestion) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
      text: 'That idea was already started or is no longer available.',
    });
    return;
  }

  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: params.query.id,
    text: `Starting: ${suggestion.title}`,
  });

  const promptText = [
    `Start this suggested task: ${suggestion.title}`,
    '',
    suggestion.brief,
    ...(suggestion.targetRepositoryFullName
      ? ['', `Target repository: ${suggestion.targetRepositoryFullName}`]
      : []),
    ...(suggestion.investigationContext
      ? ['', `Context: ${suggestion.investigationContext}`]
      : []),
  ].join('\n');
  const messageId = String(message.message_id);
  const queuedMessage: QueuedTelegramCommunicationMessage = {
    provider: 'telegram',
    text: promptText,
    user: 'Telegram operator',
    userId: senderUserId,
    ts: messageId,
    channel: chatId,
  };

  try {
    await startNewTelegramTask({
      message,
      launchOwnerUserId: senderUserId,
      queuedMessage,
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: chatId,
        communicationMessageId: messageId,
      },
    });
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to launch suggestion ${params.suggestionId} from callback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await postTelegramMessageBestEffort({
      chatId,
      replyToMessageId: messageId,
      text: `Could not start "${suggestion.title}" — try describing the task in a message instead.`,
    });
  }
}

/**
 * Dispatch a Telegram callback_query (inline keyboard click). Unknown or
 * malformed callback data is acknowledged and dropped so the button never
 * spins forever.
 */
export async function handleTelegramCallbackQuery(
  query: TelegramCallbackQuery,
): Promise<void> {
  const data = query.data?.trim() ?? '';
  const cancelCloudJobId = parseCancelTaskCallbackData(data);

  if (cancelCloudJobId !== null) {
    await handleCancelTaskCallback({ query, cloudJobId: cancelCloudJobId });
    return;
  }

  const suggestionId = parseTelegramSuggestionCallbackData(data);

  if (suggestionId !== null) {
    await handleSuggestionLaunchCallback({ query, suggestionId });
    return;
  }

  apiLogger.warn(
    `[telegram] Ignoring unknown Telegram callback data ${data || '<empty>'}`,
  );
  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: query.id,
  });
}
