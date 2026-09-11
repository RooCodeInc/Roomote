import { randomInt } from 'node:crypto';

import type { FastAgentTurnActivity } from '@roomote/cloud-agents/server';
import type { TelegramCommunicationProvider } from '@roomote/communication';

import { createFastAgentTypingActivity } from './fast-agent-typing-activity';

export const FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS = 25_000;
export const FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS = 4_000;
export const FAST_AGENT_TELEGRAM_REASSERT_DELAY_MS = 500;

function isTelegramPrivateChatId(channelId: string): boolean {
  const parsed = Number(channelId);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

/**
 * Uses Telegram's native Thinking draft in private chats. Groups do not
 * support drafts, so they retain Telegram's ordinary typing action.
 */
export function createFastAgentTelegramActivity({
  provider,
  replyTarget,
}: {
  provider: Pick<
    TelegramCommunicationProvider,
    'sendChatAction' | 'sendThinkingDraft'
  >;
  replyTarget: { channelId: string; threadId?: string };
}): FastAgentTurnActivity & { reassert: () => void } {
  const nativeThinking = isTelegramPrivateChatId(replyTarget.channelId);
  const draftId = nativeThinking ? randomInt(1, 2_147_483_647) : undefined;
  const activity = createFastAgentTypingActivity({
    sendTyping: () =>
      nativeThinking
        ? provider.sendThinkingDraft({ ...replyTarget, draftId: draftId! })
        : provider.sendChatAction(replyTarget),
    intervalMs: nativeThinking
      ? FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS
      : FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS,
  });
  let reassertTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelReassertion = () => {
    clearTimeout(reassertTimer);
    reassertTimer = undefined;
  };

  return {
    start: activity.start,
    reassert: () => {
      if (!nativeThinking) {
        activity.reassert();
        return;
      }

      // A normal Telegram message clears its draft. Restore Thinking only if
      // the turn remains active long enough to do more work; true completion
      // settles the activity and cancels this pending reassertion.
      cancelReassertion();
      reassertTimer = setTimeout(
        activity.reassert,
        FAST_AGENT_TELEGRAM_REASSERT_DELAY_MS,
      );
      reassertTimer.unref();
    },
    settle: (options) => {
      cancelReassertion();
      return activity.settle(options);
    },
    dispose: () => {
      cancelReassertion();
      return activity.dispose();
    },
  };
}
