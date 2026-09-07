import type { FastAgentReplyStream } from '@roomote/cloud-agents/server';
import {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
} from '@roomote/sdk/server';
import {
  buildFastSessionReplyFooterText,
  type FastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  postSlackThreadMessageWithFooterText,
  type SlackNotifier,
} from '@roomote/slack';

import { apiLogger } from '../../../logging.js';

type SlackThreadMarkdownPostResult =
  | { status: 'posted'; messageId: string }
  | 'suppressed'
  | 'failed';

export async function postSlackThreadMarkdownMessage({
  slack,
  channel,
  threadTs,
  text,
  sourceMessageTs,
  conversationLog,
  fastSessionFooter,
  images = [],
}: {
  slack: SlackNotifier;
  channel: string;
  threadTs: string;
  text: string;
  sourceMessageTs?: string;
  conversationLog?: {
    userId: string;
    slackTeamId: string;
    source: string;
  };
  /** Attach the sticky Fast session reply footer to this message. */
  fastSessionFooter?: { sessionId: string } & FastSessionReplyFooterContext;
  images?: Array<{ url: string; altText: string }>;
}): Promise<SlackThreadMarkdownPostResult> {
  if (sourceMessageTs) {
    const sourceMessageExists = await slack.hasMessageInThread({
      channel,
      threadTs,
      messageTs: sourceMessageTs,
    });

    if (sourceMessageExists === false) {
      apiLogger.debug(
        `[SlackWebhook] Skipping fast-agent reply because source message ${sourceMessageTs} is no longer in thread ${threadTs}`,
      );
      // Deliberate suppression (the triggering message was deleted), not a
      // Slack delivery failure; callers must not treat this as an error.
      return 'suppressed';
    }
  }

  const messageTs = fastSessionFooter
    ? await postSlackThreadMessageWithFooterText({
        slack,
        channel,
        threadTs,
        text,
        bodyBlocks: [
          { type: 'markdown', text },
          ...images.map((image) => ({
            type: 'image' as const,
            image_url: image.url,
            alt_text: image.altText,
          })),
        ],
        footerText: buildFastSessionReplyFooterText({
          provider: 'slack',
          ...fastSessionFooter,
        }),
      })
    : await slack.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        blocks: [
          {
            type: 'markdown',
            text,
          },
          ...images.map((image) => ({
            type: 'image' as const,
            image_url: image.url,
            alt_text: image.altText,
          })),
        ],
      });

  if (!messageTs) {
    return 'failed';
  }

  if (conversationLog) {
    const subject = await findSlackConversationSubjectByUserId({
      userId: conversationLog.userId,
      slackTeamId: conversationLog.slackTeamId,
    });

    if (subject) {
      await recordSlackConversationMessageBestEffort({
        logContext: 'SlackWebhook.threadReply',
        ...subject,
        senderSlackUserId: null,
        slackChannelId: channel,
        conversationKind: 'thread',
        threadTs,
        messageTs,
        direction: 'outbound',
        authorKind: 'roomote',
        source: conversationLog.source,
        text,
      });
    }
  }

  return { status: 'posted', messageId: messageTs };
}

/**
 * Applies the deleted-source rule to a streamed reply: the stream opens only
 * while the triggering message is still in the thread, and a source deleted
 * mid-stream ends it without a delivery so the regular post path suppresses
 * the reply exactly as it would have.
 */
export function guardReplyStreamBySourceMessage(
  stream: FastAgentReplyStream,
  params: {
    slack: Pick<SlackNotifier, 'hasMessageInThread'>;
    channel: string;
    threadTs: string;
    sourceMessageTs: string;
  },
): FastAgentReplyStream {
  const sourceMessagePresent = async () =>
    (await params.slack.hasMessageInThread({
      channel: params.channel,
      threadTs: params.threadTs,
      messageTs: params.sourceMessageTs,
    })) !== false;
  let presentAtOpen: Promise<boolean> | undefined;

  return {
    append: async (text) => {
      presentAtOpen ??= sourceMessagePresent();
      if (await presentAtOpen) await stream.append(text);
    },
    finish: async (reply) => {
      if (await sourceMessagePresent()) return stream.finish(reply);
      apiLogger.debug(
        `[SlackWebhook] Ending the streamed fast-agent reply because source message ${params.sourceMessageTs} is no longer in thread ${params.threadTs}`,
      );
      await stream.abort();
      return undefined;
    },
    abort: () => stream.abort(),
  };
}
