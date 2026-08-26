import {
  createFastAgentWebTaskLauncher,
  fastAgentConversationRepository,
  type FastAgentConversation,
  type FastAgentTurnAdapter,
} from '@roomote/cloud-agents/server';
import { and, db, eq, slackInstallations } from '@roomote/db/server';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
} from '@roomote/communication';
import {
  createFastAgentSlackLiveTaskLauncher,
  getSlackThreadReplyFooterMessageTs,
  postSlackThreadMessageWithFooterText,
  withSlackThreadReplyFooterLock,
  buildSlackThreadReplyFooterBlock,
  SlackNotifier,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
} from '@roomote/slack';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import {
  createFastAgentCommunicationTaskLauncher,
  createFastAgentDiscordTaskLauncher,
} from './fast-agent-parent-event';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import {
  findTeamsConversationServiceUrl,
  findTeamsWorkspaceServiceUrl,
} from '../automations/destination';

const SLACK_QUOTE_MAX_LENGTH = 100;
const DISCORD_QUOTE_MAX_LENGTH = 280;

function normalizeQuoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateQuoteText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`');
}

/** `>*{name}:* {text}` — the same one-line quote the task reply path uses. */
function buildSlackReplyQuote(params: {
  senderDisplayName: string | null;
  text: string;
}): string | null {
  const username = escapeSlackMrkdwnText(
    normalizeQuoteText(params.senderDisplayName ?? 'Someone'),
  );
  const text = escapeSlackMrkdwnText(
    truncateQuoteText(normalizeQuoteText(params.text), SLACK_QUOTE_MAX_LENGTH),
  );

  if (!username || !text) {
    return null;
  }

  return `>*${username}:* ${text}`;
}

function buildDiscordReplyQuote(params: {
  senderDisplayName: string | null;
  text: string;
}): string | null {
  const username = normalizeQuoteText(params.senderDisplayName ?? 'Someone');
  const text = truncateQuoteText(
    normalizeQuoteText(params.text),
    DISCORD_QUOTE_MAX_LENGTH,
  );

  if (!username || !text) {
    return null;
  }

  return `> **${username}:** ${text}`;
}

export type FastAgentSurfaceReplyDelivery = {
  conversation: FastAgentConversation;
  adapter: Pick<
    FastAgentTurnAdapter,
    'launchTask' | 'postReply' | 'replaceReply'
  >;
};

/**
 * Build the platform delivery for a web-initiated reply to an existing Fast
 * session: the adapter posts the agent's replies back into the conversation's
 * home surface, and the first reply carries a quote of the web-typed message
 * (mirroring the task thread-reply quote treatment). Returns null only when
 * the surface's delivery credentials are unavailable.
 */
export async function buildFastAgentSurfaceReplyDelivery(params: {
  sessionId: string;
  /** The replying user; delegated tasks are attributed to them. */
  userId: string;
  senderDisplayName: string | null;
  question: string;
}): Promise<FastAgentSurfaceReplyDelivery | null> {
  const session = await fastAgentConversationRepository.findById({
    id: params.sessionId,
  });
  if (!session) {
    return null;
  }
  const conversation = session.conversation;

  if (conversation.surface === 'web' || conversation.surface === 'automation') {
    // No side channel to post into: the canonical transcript the service
    // persists is the reply surface, and the shared conversation context
    // carries the exchange into the automation's future runs.
    return {
      conversation,
      adapter: {
        launchTask: createFastAgentWebTaskLauncher({
          userId: params.userId,
          conversation,
        }),
        postReply: async () => {},
      },
    };
  }

  if (conversation.surface === 'slack') {
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, conversation.workspaceId),
      ),
      columns: { botAccessToken: true, teamDomain: true },
    });
    if (!installation?.botAccessToken) {
      return null;
    }

    const slack = new SlackNotifier(installation.botAccessToken);
    let pendingQuote = buildSlackReplyQuote({
      senderDisplayName: params.senderDisplayName,
      text: params.question,
    });

    return {
      conversation,
      adapter: {
        launchTask: createFastAgentSlackLiveTaskLauncher({
          slack,
          userId: params.userId,
          teamId: conversation.workspaceId,
          ...(installation.teamDomain
            ? { teamDomain: installation.teamDomain }
            : {}),
          channelId: conversation.replyTarget.channelId,
          threadTs: conversation.replyTarget.threadId,
        }),
        postReply: async ({ message }) => {
          const quote = pendingQuote;
          pendingQuote = null;
          const messageTs = await postSlackThreadMessageWithFooterText({
            slack,
            channel: conversation.replyTarget.channelId,
            threadTs: conversation.replyTarget.threadId,
            text: quote ? `${quote}\n${message}` : message,
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
              { type: 'markdown' as const, text: message },
            ],
            footerText: buildFastSessionReplyFooterText({
              provider: 'slack',
              sessionId: session.id,
            }),
          });
          if (!messageTs) {
            throw new Error('Slack did not return a Fast reply timestamp.');
          }
          return { messageId: messageTs };
        },
        replaceReply: async (handle, { message }) => {
          // Keep the sticky footer when the edited message is its current
          // carrier; the lookup and edit share the footer lock so a
          // concurrent relocation cannot slip in between them.
          const updated = await withSlackThreadReplyFooterLock({
            channel: conversation.replyTarget.channelId,
            threadTs: conversation.replyTarget.threadId,
            fn: async () => {
              const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
                conversation.replyTarget.channelId,
                conversation.replyTarget.threadId,
              ).catch(() => null);
              return slack.updateMessage({
                channel: conversation.replyTarget.channelId,
                ts: handle.messageId,
                message: {
                  text: message,
                  blocks: [
                    { type: 'markdown', text: message },
                    ...(footerMessageTs === handle.messageId
                      ? [
                          buildSlackThreadReplyFooterBlock({
                            footerText: buildFastSessionReplyFooterText({
                              provider: 'slack',
                              sessionId: session.id,
                            }),
                          }),
                        ]
                      : []),
                  ],
                },
              });
            },
          });
          if (!updated) {
            throw new Error('Slack did not update the Fast reply.');
          }
          return handle;
        },
      },
    };
  }

  if (conversation.surface === 'discord') {
    const provider =
      await createDiscordCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      return null;
    }

    let pendingQuote = buildDiscordReplyQuote({
      senderDisplayName: params.senderDisplayName,
      text: params.question,
    });

    return {
      conversation,
      adapter: {
        launchTask: createFastAgentDiscordTaskLauncher({
          provider,
          userId: params.userId,
          conversation,
        }),
        postReply: async ({ message }) => {
          const quote = pendingQuote;
          pendingQuote = null;
          const footerText = buildFastSessionReplyFooterText({
            provider: 'discord',
            sessionId: session.id,
          });
          const bodyText = quote ? `${quote}\n\n${message}` : message;
          const textWithFooter = `${bodyText}\n\n${footerText}`;
          const channelId = conversation.replyTarget.channelId;
          const footerStateThreadId =
            conversation.replyTarget.threadId ?? 'root';
          const footerMessageChannelId =
            conversation.replyTarget.threadId ?? channelId;

          const posted = await deliverManagedThreadReplyFooter({
            provider: 'discord',
            providerLabel: 'Discord',
            channelId,
            footerStateThreadId,
            lockKey: `discord:thread_reply_footer_lock:${channelId}:${footerStateThreadId}`,
            logRef: `fast session ${session.id}`,
            logContext: 'fastAgentSurfaceReply',
            postReplyWithFooter: async () => {
              const result = await provider.postMessage({
                ...conversation.replyTarget,
                text: textWithFooter,
                textFormat: 'markdown',
              });
              return {
                messageId: result.lastTextMessageId ?? result.messageId,
                textWithoutFooter: getDiscordFooterlessFinalChunk({
                  textWithFooter,
                  footerText,
                }),
              };
            },
            clearPreviousFooter: async (previousFooterRecord) => {
              await provider.editMessage({
                channelId: footerMessageChannelId,
                messageId: previousFooterRecord.messageId,
                text: previousFooterRecord.textWithoutFooter,
              });
            },
          });
          return { messageId: posted.messageId };
        },
      },
    };
  }

  if (conversation.surface === 'teams') {
    const [provider, conversationServiceUrl, workspaceServiceUrl] =
      await Promise.all([
        createTeamsCommunicationProviderFromRuntimeCredentials(),
        findTeamsConversationServiceUrl(conversation.replyTarget.channelId),
        findTeamsWorkspaceServiceUrl(conversation.workspaceId),
      ]);
    const serviceUrl =
      conversation.replyTarget.serviceUrl ??
      conversationServiceUrl ??
      workspaceServiceUrl;
    if (!provider || !serviceUrl) {
      return null;
    }
    return {
      conversation,
      adapter: {
        launchTask: createFastAgentCommunicationTaskLauncher({
          userId: params.userId,
          conversation,
          serviceUrl,
        }),
        postReply: async ({ message }) => {
          const posted = await provider.postMessage({
            channelId: conversation.replyTarget.channelId,
            serviceUrl,
            ...(conversation.replyTarget.threadId
              ? {
                  threadId: conversation.replyTarget.threadId,
                  replyToMessageId: conversation.replyTarget.threadId,
                }
              : {}),
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: session.id })}`,
            textFormat: 'markdown',
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async (handle, { message }) => {
          await provider.updateMessage({
            channelId: conversation.replyTarget.channelId,
            messageId: handle.messageId,
            serviceUrl,
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: session.id })}`,
            textFormat: 'markdown',
          });
          return handle;
        },
      },
    };
  }

  if (conversation.surface === 'telegram') {
    const provider =
      await createTelegramCommunicationProviderFromRuntimeCredentials();
    if (!provider) {
      return null;
    }
    return {
      conversation,
      adapter: {
        launchTask: createFastAgentCommunicationTaskLauncher({
          userId: params.userId,
          conversation,
        }),
        postReply: async ({ message }) => {
          const posted = await provider.postMessage({
            channelId: conversation.replyTarget.channelId,
            ...(conversation.replyTarget.threadId
              ? { threadId: conversation.replyTarget.threadId }
              : {}),
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: session.id })}`,
            textFormat: 'markdown',
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async (handle, { message }) => {
          await provider.editMessageText({
            channelId: conversation.replyTarget.channelId,
            messageId: handle.messageId,
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: session.id })}`,
            textFormat: 'markdown',
          });
          return handle;
        },
      },
    };
  }

  return null;
}
