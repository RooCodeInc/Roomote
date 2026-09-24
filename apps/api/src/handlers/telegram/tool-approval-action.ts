import type { TelegramCallbackQuery } from '@roomote/communication/telegram-update';
import type { IntegrationToolApprovalDecision } from '@roomote/types';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';

import { decideCommunicationToolApproval } from '../tool-approval-action.js';
import { resolveTelegramSenderUserId } from './linked-user.js';
import { answerTelegramCallbackQueryBestEffort } from './replies.js';

export async function handleTelegramToolApprovalAction(input: {
  query: TelegramCallbackQuery;
  decision: IntegrationToolApprovalDecision;
}) {
  const { query, decision } = input;
  const userId = query.from?.id
    ? await resolveTelegramSenderUserId(String(query.from.id))
    : null;
  const accepted = await decideCommunicationToolApproval(userId, decision);
  if (accepted && query.message && 'message_id' in query.message) {
    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();
    await provider
      ?.editMessageReplyMarkup({
        channelId: String(query.message.chat.id),
        messageId: String(query.message.message_id),
      })
      .catch(() => undefined);
  }
  await answerTelegramCallbackQueryBestEffort({
    callbackQueryId: query.id,
    text: accepted
      ? decision.decision === 'rejected'
        ? 'Tool call denied.'
        : 'Tool call allowed.'
      : 'This approval is unavailable or has already been handled.',
  });
}
