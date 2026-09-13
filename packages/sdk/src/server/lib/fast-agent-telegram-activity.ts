import { randomInt } from 'node:crypto';

import type {
  FastAgentReply,
  FastAgentReplyHandle,
  FastAgentReplyStream,
  FastAgentTurnActivity,
} from '@roomote/cloud-agents/server';
import {
  isTelegramPrivateChatId,
  type TelegramCommunicationProvider,
} from '@roomote/communication';

import { createFastAgentTypingActivity } from './fast-agent-typing-activity';

export const FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS = 25_000;
export const FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS = 4_000;
// Match Slack's turn-level debounce so short Fast turns do not flicker.
export const FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS = 300;
// Pace draft updates independently of model token cadence.
export const FAST_AGENT_TELEGRAM_STREAM_INTERVAL_MS = 800;
const FAST_AGENT_TELEGRAM_THINKING_TEXT = 'Roomote is working...';

export async function runWithFastAgentTelegramActivityReassertion<T>(
  activity: { reassert: () => void },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    activity.reassert();
  }
}

/**
 * Uses a non-empty Thinking draft in private chats, then replaces it with
 * streamed response text. Groups retain Telegram's ordinary typing action.
 */
export function createFastAgentTelegramActivity({
  provider,
  replyTarget,
}: {
  provider: Pick<
    TelegramCommunicationProvider,
    'sendChatAction' | 'sendRichMessageDraft'
  >;
  replyTarget: { channelId: string; threadId?: string };
}): FastAgentTurnActivity & {
  reassert: () => void;
  supportsReplyStream: boolean;
  createReplyStream: (
    deliver: (reply: FastAgentReply) => Promise<FastAgentReplyHandle | void>,
  ) => FastAgentReplyStream;
} {
  const nativeThinking = isTelegramPrivateChatId(replyTarget.channelId);
  let nativeDraftAvailable = nativeThinking;
  const draftId = nativeThinking ? randomInt(1, 2_147_483_647) : undefined;
  let draftText = '';
  let lastDraftWriteAtMs = 0;
  const activity = createFastAgentTypingActivity({
    sendTyping: async () => {
      if (nativeDraftAvailable) {
        try {
          await provider.sendRichMessageDraft({
            ...replyTarget,
            draftId: draftId!,
            text: draftText || FAST_AGENT_TELEGRAM_THINKING_TEXT,
            ...(draftText
              ? { textFormat: 'markdown' as const }
              : {
                  htmlText: '<tg-thinking>Roomote is working...</tg-thinking>',
                }),
          });
          lastDraftWriteAtMs = Date.now();
          return;
        } catch {
          nativeDraftAvailable = false;
          draftText = '';
          console.warn(
            '[Fast Agent] Telegram live drafts unavailable; falling back to typing.',
          );
        }
      }
      await provider.sendChatAction(replyTarget);
    },
    intervalMs: () =>
      nativeDraftAvailable
        ? FAST_AGENT_TELEGRAM_DRAFT_REFRESH_MS
        : FAST_AGENT_TELEGRAM_TYPING_REFRESH_MS,
    startDelayMs: FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS,
  });
  let reassertTimer: ReturnType<typeof setTimeout> | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStreamWrite = false;

  const cancelReassertion = () => {
    clearTimeout(reassertTimer);
    reassertTimer = undefined;
  };

  const cancelStreamWrite = () => {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    pendingStreamWrite = false;
  };

  const scheduleStreamWrite = () => {
    if (!nativeDraftAvailable) return;
    pendingStreamWrite = true;
    if (streamTimer) return;
    const wait = Math.max(
      0,
      lastDraftWriteAtMs + FAST_AGENT_TELEGRAM_STREAM_INTERVAL_MS - Date.now(),
    );
    streamTimer = setTimeout(() => {
      streamTimer = undefined;
      if (!pendingStreamWrite) return;
      pendingStreamWrite = false;
      activity.reassert();
    }, wait);
    streamTimer.unref();
  };

  const schedulePostMessageReassertion = () => {
    if (!nativeThinking) {
      activity.reassert();
      return;
    }
    cancelReassertion();
    reassertTimer = setTimeout(() => {
      reassertTimer = undefined;
      activity.resume();
    }, FAST_AGENT_TELEGRAM_PROCESSING_DELAY_MS);
    reassertTimer.unref();
  };

  const stop = (
    method: 'settle' | 'dispose',
    options?: { keepProcessing?: boolean },
  ) => {
    cancelReassertion();
    cancelStreamWrite();
    return method === 'settle' ? activity.settle(options) : activity.dispose();
  };

  return {
    start: activity.start,
    supportsReplyStream: nativeThinking,
    createReplyStream: (deliver) => {
      let open = true;
      let wroteStreamText = false;
      return {
        append: async (text) => {
          if (!open || !text) return;
          draftText += text;
          if (!wroteStreamText) {
            wroteStreamText = true;
            await activity.pause();
            await activity.resume();
            return;
          }
          scheduleStreamWrite();
        },
        finish: async (reply) => {
          if (!open) return undefined;
          open = false;
          cancelStreamWrite();
          await activity.pause();
          draftText = '';
          try {
            return (await deliver(reply)) ?? undefined;
          } finally {
            // The durable rich message clears the draft. Resume Thinking only
            // if this turn continues into more tool or model work.
            schedulePostMessageReassertion();
          }
        },
        abort: async () => {
          if (!open) return;
          open = false;
          cancelStreamWrite();
          await activity.pause();
          draftText = '';
          activity.resume();
        },
      };
    },
    reassert: schedulePostMessageReassertion,
    settle: (options) => stop('settle', options),
    dispose: () => stop('dispose'),
  };
}
