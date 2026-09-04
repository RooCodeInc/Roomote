import type {
  FastAgentConversation,
  FastAgentReplyStream,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  type FastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
  relocateSlackThreadActiveTaskCards,
  updateSlackThreadMessageWithFooterText,
  withSlackThreadReplyFooterLock,
  type SlackNotifier,
} from '@roomote/slack';

import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';

/**
 * Streams a Fast reply into a Slack thread with Slack's message streaming
 * API, then rewrites the finished message into the same body the reply
 * would have been posted with (quote, markdown block, sticky footer).
 * Streaming outside a DM needs the recipient; callers without a Slack user
 * for the sender do not offer a stream.
 */
export function createSlackFastReplyStream(params: {
  slack: Pick<
    SlackNotifier,
    | 'startMessageStream'
    | 'appendMessageStream'
    | 'stopMessageStream'
    | 'deleteMessage'
    | 'updateMessage'
    | 'getMessageBlocks'
    | 'getRawMessage'
    | 'postMessage'
  >;
  conversation: FastAgentConversation;
  channelId: string;
  threadTs: string;
  recipientTeamId: string;
  recipientUserId: string;
  sessionId: string;
  footerContext: FastSessionReplyFooterContext;
  /** The pending quote a first reply leads with, cleared after delivery. */
  getQuote?: () => string | null;
  onDelivered?: () => void;
}): FastAgentReplyStream {
  let messageTs: string | null = null;
  let opened = false;
  let failed = false;

  return {
    append: async (text) => {
      if (failed || !text) return;
      if (!messageTs) {
        if (opened) return;
        opened = true;
        messageTs = await withSlackThreadReplyFooterLock({
          channel: params.channelId,
          threadTs: params.threadTs,
          fn: async () => {
            try {
              await relocateSlackThreadActiveTaskCards({
                slack: params.slack,
                channel: params.channelId,
                threadTs: params.threadTs,
              });
            } catch (error) {
              console.warn(
                `[Fast Agent] Failed to relocate active Slack task cards before streaming: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return params.slack.startMessageStream({
              channel: params.channelId,
              threadTs: params.threadTs,
              recipientTeamId: params.recipientTeamId,
              recipientUserId: params.recipientUserId,
              markdownText: text,
            });
          },
        });
        if (!messageTs) failed = true;
        return;
      }
      const appended = await params.slack.appendMessageStream({
        channel: params.channelId,
        ts: messageTs,
        markdownText: text,
      });
      // The finish rewrites the whole message, so a lost append only costs
      // liveness, never content.
      if (!appended) failed = true;
    },
    finish: async (reply) => {
      const ts = messageTs;
      if (!ts) return undefined;
      messageTs = null;
      await params.slack.stopMessageStream({ channel: params.channelId, ts });
      const quote = params.getQuote?.() ?? null;
      let updated = false;
      try {
        updated = await updateSlackThreadMessageWithFooterText({
          slack: params.slack,
          channel: params.channelId,
          threadTs: params.threadTs,
          messageTs: ts,
          text: quote ? `${quote}\n${reply.message}` : reply.message,
          bodyBlocks: [
            ...(quote
              ? [
                  {
                    type: 'section' as const,
                    block_id: ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
                    text: { type: 'mrkdwn' as const, text: quote },
                  },
                ]
              : []),
            { type: 'markdown' as const, text: reply.message },
          ],
          footerText: buildFastSessionReplyFooterText({
            provider: 'slack',
            sessionId: params.sessionId,
            ...params.footerContext,
          }),
        });
      } catch (error) {
        console.warn(
          `[Fast Agent] Failed to apply the final body to streamed Slack reply ${ts}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!updated) {
        const deleted = await params.slack
          .deleteMessage({ channel: params.channelId, ts })
          .catch(() => false);
        if (deleted) {
          console.warn(
            `[Fast Agent] Slack did not accept the final body for streamed reply ${ts}; removed the partial stream so the reply can post normally.`,
          );
          return undefined;
        }
        console.error(
          `[Fast Agent] Slack did not accept the final body for streamed reply ${ts}, and the partial stream could not be removed; keeping it as the delivery.`,
        );
      }
      await recordFastAgentConversationMessageBestEffort({
        sessionId: params.sessionId,
        conversation: params.conversation,
        messageId: ts,
      });
      params.onDelivered?.();
      return { messageId: ts };
    },
    abort: async () => {
      const ts = messageTs;
      if (!ts) return;
      messageTs = null;
      await params.slack.stopMessageStream({ channel: params.channelId, ts });
    },
  };
}
