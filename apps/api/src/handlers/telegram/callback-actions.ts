import type { TelegramCallbackQuery } from '@roomote/communication/telegram-update';
import { activeRunStatuses } from '@roomote/types';
import {
  and,
  db,
  eq,
  finalizeWorkItemLaunched,
  inArray,
  isNull,
  releaseWorkItemClaim,
  sql,
  taskRuns,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { cancelOrphanedWorkItemRunBestEffort } from '../tasks/orphaned-work-item-run.js';
import { stopTaskJob } from '../tasks/task-stop.js';
import {
  parseCancelTaskCallbackData,
  parseTelegramRouteCallbackData,
} from './callback-data.js';
import { resolveTelegramSenderUserId } from './linked-user.js';
import {
  answerTelegramCallbackQueryBestEffort,
  clearTelegramMessageButtonsBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';
import { handleTelegramRoutingCallback } from './routing-confirmation.js';
import {
  claimTelegramSuggestionLaunch,
  parseTelegramSuggestionCallbackData,
} from './setup-suggestions.js';
import { startNewTelegramTask } from './task-orchestration.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';

async function findCancelableCloudJob(cloudJobId: number, chatId: string) {
  return db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.id, cloudJobId),
      // Only cancel jobs launched from the chat the button lives in — the
      // inbound message path is chat-scoped the same way.
      sql`${taskRuns.payload}->>'communicationProvider' = 'telegram'`,
      sql`${taskRuns.payload}->>'communicationChannelId' = ${chatId}`,
      inArray(taskRuns.status, [...activeRunStatuses]),
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

  const cancelledByName =
    [params.query.from.first_name, params.query.from.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || params.query.from.username;

  const stopResult = await stopTaskJob({
    job: cancelableJob,
    allowDirectCancelWithoutSandbox: true,
    cancelledBy: {
      ...(cancelledByName ? { name: cancelledByName } : {}),
      source: 'telegram',
    },
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

  // The claim's `launchClaimedAt` is this launcher's fencing token; thread it
  // through finalize/release so a slow launcher whose stale claim was
  // reclaimed cannot stomp the new claimant's state.
  const claimedAt = suggestion.launchClaimedAt;

  try {
    const started = await startNewTelegramTask({
      message,
      launchOwnerUserId: senderUserId,
      queuedMessage,
      metadata: {
        communicationProvider: 'telegram',
        communicationChannelId: chatId,
        communicationMessageId: messageId,
      },
      // The button click already is the explicit start signal.
      skipRoutingConfirmation: true,
    });

    if (started.status === 'started') {
      // Close the launch state machine: `launching` -> `launched` with the
      // task link, so a later click can never relaunch this suggestion and the
      // task stays linked to its work item.
      const finalized = await finalizeWorkItemLaunched(db, {
        id: params.suggestionId,
        taskId: started.launchResult.taskId,
        claimedAt,
      });

      if (!finalized) {
        // The task is already enqueued but the fencing guard rejected the
        // finalize (our stale claim was reclaimed by another launcher), so
        // the run is orphaned from the work item. Best-effort cancel it while
        // it is still pre-sandbox; log loudly either way with the outcome.
        const cancelNote = await cancelOrphanedWorkItemRunBestEffort(
          started.launchResult.id,
        );

        apiLogger.warn(
          `[telegram] finalize lost the fencing guard for work item ${params.suggestionId}; task ${started.launchResult.taskId} (run ${started.launchResult.id}) was orphaned — ${cancelNote}`,
        );

        // The callback was already answered "Starting: ..." and the launch
        // path already posted a started message pointing at the orphan, so
        // post a corrective reply: the user must follow the winning launch,
        // not the canceled duplicate. (Deferring the started post until after
        // finalize would change startNewTelegramTask's contract for its other
        // callers, so correct instead.)
        await postTelegramMessageBestEffort({
          chatId,
          replyToMessageId: messageId,
          text: `"${suggestion.title}" was already started elsewhere — this duplicate task was canceled.`,
        });
      }
    } else {
      // No task was launched: routing answered inline (`replied_inline`), or —
      // defensively, since skipRoutingConfirmation is set — a confirmation was
      // requested. Release the claim so the suggestion is retryable now
      // instead of dead for the 10-minute stale window.
      await releaseWorkItemClaim(db, { id: params.suggestionId, claimedAt });
    }
  } catch (error) {
    apiLogger.warn(
      `[telegram] Failed to launch suggestion ${params.suggestionId} from callback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    // Release the claim (fenced on our token) so the suggestion becomes
    // retryable immediately rather than after the 10-minute stale window.
    await releaseWorkItemClaim(db, {
      id: params.suggestionId,
      claimedAt,
    }).catch((releaseError) => {
      apiLogger.warn(
        `[telegram] Failed to release claim for work item ${params.suggestionId} after launch failure: ${
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError)
        }`,
      );
    });

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

  const routeAction = parseTelegramRouteCallbackData(data);

  if (routeAction !== null) {
    await handleTelegramRoutingCallback({ query, action: routeAction });
    return;
  }

  apiLogger.warn(
    `[telegram] Ignoring unknown Telegram callback data ${data || '<empty>'}`,
  );
  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: query.id,
  });
}
