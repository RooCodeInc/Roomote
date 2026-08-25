import type { TelegramCallbackQuery } from '@roomote/communication/telegram-update';
import {
  claimPendingPrReviewAction,
  claimPendingPrReviewActionsForThread,
  dispatchPrReviewFollowUp,
  enableAutoHandlePrReviewFeedback,
} from '@roomote/sdk/server';
import type { PrReviewActionChoice } from '@roomote/types';

import { apiLogger } from '../../logging.js';
import { resolveTelegramSenderUserId } from './linked-user.js';
import {
  answerTelegramCallbackQueryBestEffort,
  clearTelegramMessageButtonsBestEffort,
  postTelegramMessageBestEffort,
} from './replies.js';

/**
 * Handles clicks on a PR review-feedback notification's Yes / auto-handle /
 * Dismiss buttons in Telegram: claims the nonce-keyed pending offer and, on
 * acceptance, dispatches the prepared follow-up prompt into the owning task —
 * queued into the live run or waking the task from its snapshot.
 */
export async function handleTelegramPrReviewActionCallback(params: {
  query: TelegramCallbackQuery;
  choice: PrReviewActionChoice;
  nonce: string;
}): Promise<void> {
  const { query, choice, nonce } = params;
  const message = query.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
  const messageId =
    message && 'message_id' in message ? String(message.message_id) : null;
  const threadId =
    message &&
    'message_thread_id' in message &&
    message.message_thread_id != null
      ? String(message.message_thread_id)
      : undefined;

  const senderUserId = query.from?.id
    ? await resolveTelegramSenderUserId(String(query.from.id))
    : null;
  const senderName = query.from
    ? [query.from.first_name, query.from.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || query.from.username
    : undefined;

  if (choice !== 'dismiss' && !senderUserId) {
    // Not claimed: a teammate with a linked account can still accept.
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'Link your Roomote account to start work from this notification.',
    });
    return;
  }

  const pending = await claimPendingPrReviewAction(nonce);

  if (!pending) {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'This offer was already handled or has expired.',
    });
    if (chatId && messageId) {
      await clearTelegramMessageButtonsBestEffort({ chatId, messageId });
    }
    return;
  }

  if (chatId && messageId) {
    await clearTelegramMessageButtonsBestEffort({ chatId, messageId });
  }

  if (choice === 'dismiss') {
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'Dismissed.',
    });

    return;
  }

  try {
    if (choice === 'auto') {
      await enableAutoHandlePrReviewFeedback({
        taskId: pending.taskId,
        repository: pending.repository,
        prNumber: pending.prNumber,
        userId: senderUserId!,
      });
    }

    const dispatched = await dispatchPrReviewFollowUp({
      provider: 'telegram',
      taskId: pending.taskId,
      channelId: pending.channelId,
      threadId: pending.threadId,
      followUpPrompt: pending.followUpPrompt,
      actingUserId: senderUserId!,
      providerUserId: query.from?.id ? String(query.from.id) : undefined,
    });

    if (dispatched.outcome === 'unavailable') {
      await answerTelegramCallbackQueryBestEffort({
        callbackQueryId: query.id,
        text: 'This task can no longer be resumed.',
      });

      if (chatId) {
        await postTelegramMessageBestEffort({
          chatId,
          ...(threadId !== undefined ? { threadId } : {}),
          ...(messageId ? { replyToMessageId: messageId } : {}),
          text:
            choice === 'auto'
              ? "I'll resolve future feedback on this PR, but this task can no longer be resumed for the current feedback. Reply here to start fresh."
              : 'This task can no longer be resumed. Reply here to start fresh.',
        });
      }

      if (choice !== 'auto') {
        return;
      }
    }

    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: choice === 'auto' ? 'Auto-resolve enabled.' : 'On it.',
    });

    if (chatId && messageId) {
      if (dispatched.outcome !== 'unavailable') {
        await postTelegramMessageBestEffort({
          chatId,
          ...(threadId !== undefined ? { threadId } : {}),
          replyToMessageId: messageId,
          text:
            choice === 'auto'
              ? `OK, ${senderName ?? 'there'}. Future review feedback on this PR will get resolved automatically.`
              : 'On it — resolving the review feedback.',
        });
      }
    }
  } catch (error) {
    apiLogger.error(
      `[telegram] Failed to dispatch PR review follow-up for ${pending.repository}#${pending.prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await answerTelegramCallbackQueryBestEffort({
      callbackQueryId: query.id,
      text: 'Failed to start the follow-up. Reply in this chat to ask again.',
    });
  }
}

/**
 * Retires any pending PR review offers bound to a Telegram conversation
 * because a typed reply superseded them. Claims atomically and strips the
 * buttons from each posted offer. Fire-and-forget.
 */
export function retireTelegramPrReviewOffersBestEffort({
  chatId,
  threadId,
}: {
  chatId: string;
  threadId: string | null;
}): void {
  void (async () => {
    const claimed = await claimPendingPrReviewActionsForThread({
      provider: 'telegram',
      channelId: chatId,
      threadId,
    });

    for (const pending of claimed) {
      if (pending.messageId) {
        await clearTelegramMessageButtonsBestEffort({
          chatId,
          messageId: pending.messageId,
        });
      }
    }
  })().catch((error: unknown) => {
    apiLogger.warn(
      `[telegram] Failed to retire PR review offers for chat ${chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
