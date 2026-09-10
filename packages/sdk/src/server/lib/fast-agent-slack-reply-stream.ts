import type {
  FastAgentConversation,
  FastAgentReplyStream,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  type FastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  updateSlackThreadMessageWithFooterText,
  type SlackNotifier,
} from '@roomote/slack';

import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';
import { deliverFastAgentSessionVideos } from './fast-agent-session-videos';
import { buildFastAgentSlackReplyBodyBlocks } from './fast-agent-slack-reply-blocks';

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
  resolveImages?: (
    artifactIds: string[],
  ) => Promise<Array<{ url: string; altText: string }>>;
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
        messageTs = await params.slack.startMessageStream({
          channel: params.channelId,
          threadTs: params.threadTs,
          recipientTeamId: params.recipientTeamId,
          recipientUserId: params.recipientUserId,
          markdownText: text,
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
      // Message completion (even a closeout) is not turn completion.
      // The registered turn activity cleanup owns the final idle transition.
      await params.slack.stopMessageStream({
        channel: params.channelId,
        ts,
        sessionStatus: 'processing',
      });
      const quote = params.getQuote?.() ?? null;
      const images = reply.imageArtifactIds?.length
        ? ((await params.resolveImages?.(reply.imageArtifactIds)) ?? [])
        : [];
      const updateBody = async (message: string) => {
        try {
          return await updateSlackThreadMessageWithFooterText({
            slack: params.slack,
            channel: params.channelId,
            threadTs: params.threadTs,
            messageTs: ts,
            text: quote ? `${quote}\n${message}` : message,
            bodyBlocks: buildFastAgentSlackReplyBodyBlocks({
              message,
              quote,
              charts: reply.charts,
              images,
            }),
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
          return false;
        }
      };
      let updated = await updateBody(reply.message);
      // Upload only after Slack accepts the visible reply. The transport deduplicates
      // uploads if a failed fallback rewrite leaves delivery to postReply.
      const videoFallback =
        updated && reply.videoArtifactIds?.length
          ? await deliverFastAgentSessionVideos({
              artifactIds: reply.videoArtifactIds,
              sessionId: params.sessionId,
              channelId: params.channelId,
              threadTs: params.threadTs,
            })
          : '';
      if (videoFallback) {
        updated = await updateBody(
          [reply.message, videoFallback].filter(Boolean).join('\n\n'),
        );
      }
      if (!updated) {
        if (videoFallback) {
          // Keep the accepted text beside any successfully uploaded videos.
          // The normal post path still needs to deliver the missing fallback.
          console.warn(
            `[Fast Agent] Slack did not accept the video fallback for streamed reply ${ts}; keeping the text reply while fallback delivery retries normally.`,
          );
          return undefined;
        }
        const deleted = await params.slack
          .deleteMessage({ channel: params.channelId, ts })
          .catch(() => false);
        if (deleted || reply.videoArtifactIds?.length) {
          console.warn(
            `[Fast Agent] Slack did not accept the final body for streamed reply ${ts}; ${deleted ? 'removed the partial stream' : 'video delivery is still pending'} so the reply can post normally.`,
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
      await params.slack.stopMessageStream({
        channel: params.channelId,
        ts,
        sessionStatus: 'processing',
      });
    },
  };
}
