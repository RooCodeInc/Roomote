import type {
  TelegramCallbackQuery,
  TelegramMessageReaction,
} from '@roomote/communication/telegram-update';
import {
  MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE,
  activeRunStatuses,
  isDeploymentReadOnlyError,
  parsePrReviewActionCallbackData,
} from '@roomote/types';
import {
  and,
  db,
  eq,
  inArray,
  isNull,
  releaseWorkItemClaim,
  sql,
  taskRuns,
} from '@roomote/db/server';

import { apiLogger } from '../../logging.js';
import { launchClaimedSuggestedTask } from '../tasks/suggestion-launch.js';
import {
  claimCurrentThreadSuggestionByMessage,
  findCurrentThreadSuggestionIdByMessage,
  type ClaimedCurrentThreadSuggestion,
} from '../tasks/current-thread-suggestion-reaction.js';
import { stopTaskRun } from '../tasks/task-stop.js';
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
import { resolveTelegramWorkspace } from './task-launch.js';
import type { QueuedTelegramCommunicationMessage } from './types.js';

async function findCancelableTaskRun(runId: number, chatId: string) {
  return db.query.taskRuns.findFirst({
    where: and(
      eq(taskRuns.id, runId),
      // Only cancel task runs launched from the chat the button lives in — the
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
  runId: number;
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

  const cancelableRun = await findCancelableTaskRun(params.runId, chatId);

  if (!cancelableRun) {
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

  const stopResult = await stopTaskRun({
    run: cancelableRun,
    allowDirectCancelWithoutSandbox: true,
    // Provider Cancel is terminal: stop the turn and kill the sandbox.
    terminate: true,
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
      `[telegram] Failed to cancel task run ${params.runId} from callback: ${JSON.stringify(stopResult)}`,
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
      ...(message.message_thread_id !== undefined
        ? { threadId: String(message.message_thread_id) }
        : {}),
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
  claimedSuggestion?: ClaimedCurrentThreadSuggestion;
  senderUserId?: string;
  answerCallback?: boolean;
}): Promise<void> {
  const message = params.query.message;
  const chatId = message ? String(message.chat.id) : null;

  if (!chatId || !message) {
    if (params.answerCallback !== false) {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: params.query.id,
      });
    }
    return;
  }

  const senderUserId =
    params.senderUserId ??
    (await resolveTelegramSenderUserId(String(params.query.from.id)));

  if (!senderUserId) {
    if (params.claimedSuggestion) {
      await releaseWorkItemClaim(db, {
        id: params.claimedSuggestion.id,
        claimedAt: params.claimedSuggestion.launchClaimedAt,
      });
    }
    if (params.answerCallback !== false) {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: params.query.id,
        text: 'Link your Roomote account to start tasks from Telegram.',
      });
    } else {
      await postTelegramMessageBestEffort({
        chatId,
        replyToMessageId: String(message.message_id),
        text: 'Link your Roomote account to start tasks from Telegram.',
      });
    }
    return;
  }

  const suggestion =
    params.claimedSuggestion ??
    (await claimTelegramSuggestionLaunch({
      suggestionId: params.suggestionId,
      chatId,
    }));

  if (!suggestion) {
    if (params.answerCallback !== false) {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: params.query.id,
        text: 'That idea was already started or is no longer available.',
      });
    }
    return;
  }

  if (params.answerCallback !== false) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: params.query.id,
      text: `Starting: ${suggestion.title}`,
    });
  }

  const promptText = [
    `Start this suggested task: ${suggestion.title}`,
    '',
    suggestion.brief,
    ...(suggestion.targetRepositoryFullName
      ? ['', `Target repository: ${suggestion.targetRepositoryFullName}`]
      : []),
    ...(suggestion.targetEnvironmentId
      ? ['', `Target environment: ${suggestion.targetEnvironmentId}`]
      : []),
    ...(suggestion.investigationContext
      ? ['', `Context: ${suggestion.investigationContext}`]
      : []),
  ].join('\n');
  const messageId = String(message.message_id);
  const threadId =
    message.message_thread_id === undefined
      ? undefined
      : String(message.message_thread_id);
  const queuedMessage: QueuedTelegramCommunicationMessage = {
    provider: 'telegram',
    text: promptText,
    user:
      [params.query.from.first_name, params.query.from.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      params.query.from.username ||
      `Telegram user ${params.query.from.id}`,
    userId: senderUserId,
    ts: messageId,
    channel: chatId,
    ...(threadId ? { threadTs: threadId } : {}),
  };

  // The claim's `launchClaimedAt` is this launcher's fencing token; thread it
  // through finalize/release so a slow launcher whose stale claim was
  // reclaimed cannot stomp the new claimant's state.
  const claimedAt = suggestion.launchClaimedAt;

  try {
    const workspaceOverride = suggestion.targetEnvironmentId
      ? await resolveTelegramWorkspace({
          type: 'environment',
          id: suggestion.targetEnvironmentId,
          name: suggestion.targetEnvironmentId,
        })
      : undefined;
    if (suggestion.targetEnvironmentId && !workspaceOverride) {
      throw new Error('The suggestion target environment is unavailable.');
    }
    const launchResult = await launchClaimedSuggestedTask({
      suggestion: { id: params.suggestionId, launchClaimedAt: claimedAt },
      policy: {
        usesRouterLaunch: suggestion.usesRouterLaunch === true,
        userDefaultEnabled: false,
        fastAvailable: false,
      },
      launch: async () => {
        const started = await startNewTelegramTask({
          message,
          launchOwnerUserId: senderUserId,
          queuedMessage,
          metadata: {
            communicationProvider: 'telegram',
            communicationChannelId: chatId,
            ...(threadId ? { communicationThreadId: threadId } : {}),
            communicationMessageId: messageId,
          },
          // The button click already is the explicit start signal.
          skipRoutingConfirmation: true,
          forceNewTopic: true,
          ...(workspaceOverride ? { workspaceOverride } : {}),
        });
        return started.status === 'started'
          ? {
              accepted: true,
              runId: started.launchResult.id,
              taskId: started.launchResult.taskId,
            }
          : { accepted: false };
      },
    });

    if (
      launchResult.status === 'finalize_lost' ||
      launchResult.status === 'finalize_failed'
    ) {
      apiLogger.warn(
        `[telegram] failed to finalize work item ${params.suggestionId}; task ${launchResult.taskId ?? 'null'} (run ${launchResult.runId ?? 'null'}) — ${launchResult.cancelNote}`,
      );
      await postTelegramMessageBestEffort({
        chatId,
        replyToMessageId: messageId,
        text: `"${suggestion.title}" was already started elsewhere — this duplicate task was canceled.`,
      });
    } else if (launchResult.status === 'failed') {
      await postTelegramMessageBestEffort({
        chatId,
        replyToMessageId: messageId,
        text: launchResult.readOnly
          ? MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE
          : `Could not start "${suggestion.title}" — try describing the task in a message instead.`,
      });
    }
  } catch (error) {
    const blockedByReadOnly = isDeploymentReadOnlyError(error);
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
      text: blockedByReadOnly
        ? MANAGED_DEPLOYMENT_READ_ONLY_MESSAGE
        : `Could not start "${suggestion.title}" — try describing the task in a message instead.`,
    });
  }
}

export async function handleTelegramSuggestionReaction(
  reaction: TelegramMessageReaction,
): Promise<boolean> {
  if (!reaction.user) {
    return false;
  }

  const chatId = String(reaction.chat.id);
  const messageId = String(reaction.message_id);
  const suggestionId = await findCurrentThreadSuggestionIdByMessage({
    surface: 'telegram',
    channelId: chatId,
    messageId,
  });
  if (!suggestionId) {
    return false;
  }

  const senderUserId = await resolveTelegramSenderUserId(
    String(reaction.user.id),
  );
  if (!senderUserId) {
    await postTelegramMessageBestEffort({
      chatId,
      replyToMessageId: messageId,
      text: 'Link your Roomote account to start tasks from Telegram.',
    });
    return true;
  }

  const claim = await claimCurrentThreadSuggestionByMessage({
    surface: 'telegram',
    channelId: chatId,
    messageId,
  });
  if (claim.outcome === 'no_card') {
    return false;
  }
  if (claim.outcome === 'already_started') {
    await postTelegramMessageBestEffort({
      chatId,
      replyToMessageId: messageId,
      text: 'That idea was already started or is no longer available.',
    });
    return true;
  }
  const suggestion = claim.suggestion;

  await handleSuggestionLaunchCallback({
    query: {
      id: `reaction:${chatId}:${messageId}:${reaction.user.id}`,
      from: reaction.user,
      message: {
        message_id: reaction.message_id,
        ...(reaction.message_thread_id !== undefined
          ? { message_thread_id: reaction.message_thread_id }
          : {}),
        date: reaction.date,
        chat: reaction.chat,
      },
    },
    suggestionId: suggestion.id,
    claimedSuggestion: suggestion,
    senderUserId,
    answerCallback: false,
  });
  return true;
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
  const cancelRunId = parseCancelTaskCallbackData(data);

  if (cancelRunId !== null) {
    await handleCancelTaskCallback({ query, runId: cancelRunId });
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

  const prReviewAction = parsePrReviewActionCallbackData(data);
  if (prReviewAction) {
    const { handleTelegramPrReviewActionCallback } =
      await import('./pr-review-action.js');
    await handleTelegramPrReviewActionCallback({
      query,
      choice: prReviewAction.choice,
      nonce: prReviewAction.nonce,
    });
    return;
  }

  // Structured request_user_input option buttons (discord:rui:...).
  const chatId = query.message?.chat?.id;
  if (chatId != null) {
    const { resolveTelegramSenderUserId } = await import('./linked-user.js');
    const { tryHandleTelegramRequestUserInputCallback } =
      await import('./request-user-input.js');
    const senderUserId = query.from?.id
      ? await resolveTelegramSenderUserId(String(query.from.id))
      : null;
    const threadId =
      query.message &&
      'message_thread_id' in query.message &&
      query.message.message_thread_id != null
        ? String(query.message.message_thread_id)
        : null;
    const handled = await tryHandleTelegramRequestUserInputCallback({
      customId: data,
      userId: senderUserId,
      chatId: String(chatId),
      threadId,
      callbackQueryId: query.id,
      messageId:
        query.message && 'message_id' in query.message
          ? String(query.message.message_id)
          : undefined,
    });
    if (handled) {
      return;
    }
  }

  apiLogger.warn(
    `[telegram] Ignoring unknown Telegram callback data ${data || '<empty>'}`,
  );
  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: query.id,
  });
}
