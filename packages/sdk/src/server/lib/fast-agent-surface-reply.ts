import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  fastAgentConversationRepository,
  getActiveFastAgentTasks,
  resolveApiBaseUrl,
  type FastAgentConversation,
  type FastAgentReactionExternalInput,
  type FastAgentTurnAdapter,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  fastAgentMessages,
  slackInstallations,
  sql,
} from '@roomote/db/server';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
  resolveFastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  createFastAgentSlackLiveTaskLauncher,
  createFastAgentSlackSessionActivity,
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
import { createAgentMailCommunicationProviderFromRuntimeCredentials } from './agentmail-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsConversationRoute } from '../automations/destination';
import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';
import { resolveUserMcpServerConfigs } from '../routers/mcp-connections';

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
    'activity' | 'launchTask' | 'postReply' | 'replaceReply'
  >;
};

type FastAgentSurfaceReplyParams = {
  sessionId: string;
  userId: string;
  senderDisplayName: string | null;
  question: string;
  currentMessageId: string;
  replyToMessageId?: string;
  images?: string[];
  externalInput?: FastAgentReactionExternalInput;
};

export async function canUserAccessFastAgentSession(params: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const [session] = await db
    .select({ id: fastAgentMessages.conversationId })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, params.sessionId),
        sql`${fastAgentMessages.metadata} ->> 'userId' = ${params.userId}`,
      ),
    )
    .limit(1);

  if (session) return true;

  const conversation = await fastAgentConversationRepository.findById({
    id: params.sessionId,
  });
  return conversation?.userId === params.userId;
}

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
  currentMessageId?: string;
  replyToMessageId?: string;
  externalInput?: FastAgentReactionExternalInput;
}): Promise<FastAgentSurfaceReplyDelivery | null> {
  const session = await fastAgentConversationRepository.findById({
    id: params.sessionId,
  });
  if (!session) {
    return null;
  }
  if (
    !(await canUserAccessFastAgentSession({
      sessionId: session.id,
      userId: params.userId,
    }))
  ) {
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

  const footerContext = await resolveFastSessionReplyFooterContext({
    sessionId: session.id,
  });

  if (conversation.surface === 'slack') {
    const threadId = conversation.replyTarget.threadId;
    if (!threadId) {
      return null;
    }
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
    let pendingQuote = params.externalInput
      ? null
      : buildSlackReplyQuote({
          senderDisplayName: params.senderDisplayName,
          text: params.question,
        });

    return {
      conversation,
      adapter: {
        activity: createFastAgentSlackSessionActivity({
          slack,
          workspaceId: conversation.workspaceId,
          channel: conversation.replyTarget.channelId,
          threadTs: threadId,
          title: session.title,
          resolveTitle: async () =>
            (await fastAgentConversationRepository.findById({ id: session.id }))
              ?.title,
        }),
        launchTask: createFastAgentSlackLiveTaskLauncher({
          slack,
          userId: params.userId,
          teamId: conversation.workspaceId,
          ...(installation.teamDomain
            ? { teamDomain: installation.teamDomain }
            : {}),
          channelId: conversation.replyTarget.channelId,
          threadTs: threadId,
        }),
        postReply: async ({ message }) => {
          const quote = pendingQuote;
          pendingQuote = null;
          const messageTs = await postSlackThreadMessageWithFooterText({
            slack,
            channel: conversation.replyTarget.channelId,
            threadTs: threadId,
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
              ...footerContext,
            }),
          });
          if (!messageTs) {
            throw new Error('Slack did not return a Fast reply timestamp.');
          }
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: messageTs,
          });
          return { messageId: messageTs };
        },
        replaceReply: async (handle, { message }) => {
          // Keep the sticky footer when the edited message is its current
          // carrier; the lookup and edit share the footer lock so a
          // concurrent relocation cannot slip in between them.
          const updated = await withSlackThreadReplyFooterLock({
            channel: conversation.replyTarget.channelId,
            threadTs: threadId,
            fn: async () => {
              const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
                conversation.replyTarget.channelId,
                threadId,
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
                              ...footerContext,
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
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: handle.messageId,
          });
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

    let pendingQuote = params.externalInput
      ? null
      : buildDiscordReplyQuote({
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
            ...footerContext,
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
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.messageId,
          });
          return { messageId: posted.messageId };
        },
      },
    };
  }

  if (conversation.surface === 'teams') {
    const [provider, route] = await Promise.all([
      createTeamsCommunicationProviderFromRuntimeCredentials(),
      findTeamsConversationRoute(
        conversation.replyTarget.channelId,
        conversation.workspaceId,
      ),
    ]);
    if (!provider || !route) {
      return null;
    }
    const serviceUrl = route.serviceUrl;
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
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: session.id, ...footerContext })}`,
            textFormat: 'markdown',
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.messageId,
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async (handle, { message }) => {
          await provider.updateMessage({
            channelId: conversation.replyTarget.channelId,
            messageId: handle.messageId,
            serviceUrl,
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'teams', sessionId: session.id, ...footerContext })}`,
            textFormat: 'markdown',
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: handle.messageId,
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
    const replyToMessageId = params.replyToMessageId ?? params.currentMessageId;
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
            ...(replyToMessageId ? { replyToMessageId } : {}),
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: session.id, ...footerContext })}`,
            textFormat: 'markdown',
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.lastTextMessageId ?? posted.messageId,
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async (handle, { message }) => {
          await provider.editMessageText({
            channelId: conversation.replyTarget.channelId,
            messageId: handle.messageId,
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'telegram', sessionId: session.id, ...footerContext })}`,
            textFormat: 'markdown',
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: handle.messageId,
          });
          return handle;
        },
      },
    };
  }

  if (conversation.surface === 'agentmail') {
    const provider =
      await createAgentMailCommunicationProviderFromRuntimeCredentials();
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
        // The adapter resolves the durable reply anchor and recipient from
        // the conversation row; threadId carries the internal conversation
        // id. A sent email is immutable, so replaceReply keeps the original
        // message instead of editing (email is one final reply per turn,
        // never a streamed draft).
        postReply: async ({ message }) => {
          const posted = await provider.postMessage({
            channelId: conversation.replyTarget.channelId,
            threadId: conversation.conversationId,
            text: `${message}\n\n${buildFastSessionReplyFooterText({ provider: 'agentmail', sessionId: session.id, ...footerContext })}`,
            textFormat: 'markdown',
          });
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.lastTextMessageId ?? posted.messageId,
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async (handle) => handle,
      },
    };
  }

  return null;
}

export async function continueFastAgentSurfaceReply(
  params: FastAgentSurfaceReplyParams,
): Promise<boolean> {
  const delivery = await buildFastAgentSurfaceReplyDelivery(params);
  if (!delivery) {
    return false;
  }

  return runFastAgentSurfaceReply({ ...params, delivery });
}

async function runFastAgentSurfaceReply(
  params: FastAgentSurfaceReplyParams & {
    delivery: FastAgentSurfaceReplyDelivery;
  },
): Promise<boolean> {
  const { delivery } = params;

  const release = await acquireFastAgentTurnLock({
    conversation: delivery.conversation,
  });
  if (!release) {
    return false;
  }

  try {
    await runFastAgentSurfaceReplyWithSignal(params, release.signal);
    return true;
  } finally {
    await release().catch(() => {});
  }
}

/**
 * Run one surface turn while the CALLER owns the Fast turn lock. Durable
 * queue drainers (AgentMail inbound turns) hold the lock across a whole
 * ordered drain, so the per-turn acquire in `runFastAgentSurfaceReply` would
 * deadlock; this awaited variant mirrors `deliverFastAgentParentEventWithLock`.
 */
export async function continueFastAgentSurfaceReplyWithLock(
  params: FastAgentSurfaceReplyParams,
  turnSignal: AbortSignal,
): Promise<boolean> {
  const delivery = await buildFastAgentSurfaceReplyDelivery(params);
  if (!delivery) {
    return false;
  }

  await runFastAgentSurfaceReplyWithSignal({ ...params, delivery }, turnSignal);
  return true;
}

async function runFastAgentSurfaceReplyWithSignal(
  params: FastAgentSurfaceReplyParams & {
    delivery: FastAgentSurfaceReplyDelivery;
  },
  turnSignal: AbortSignal,
): Promise<void> {
  const { delivery } = params;
  const release = { signal: turnSignal };

  const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
  {
    const activeTasks = params.externalInput
      ? await getActiveFastAgentTasks(params.sessionId)
      : undefined;
    await answerFastAgentQuestion({
      question: params.question,
      images: params.images,
      userId: params.userId,
      apiBaseUrl,
      conversation: delivery.conversation,
      currentMessageId: params.currentMessageId,
      signal: release.signal,
      senderDisplayName: params.senderDisplayName ?? undefined,
      ...(activeTasks ? { activeTasks } : {}),
      ...(params.externalInput
        ? {
            senderExternalId: params.externalInput.reactor.externalUserId,
            input: {
              type: 'reaction' as const,
              externalInput: params.externalInput,
            },
          }
        : {}),
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: params.userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        ...delivery.adapter,
      },
    });
  }
}

export async function queueFastAgentSurfaceReply(
  params: FastAgentSurfaceReplyParams,
): Promise<boolean> {
  const delivery = await buildFastAgentSurfaceReplyDelivery(params);
  if (!delivery) return false;

  void runFastAgentSurfaceReply({ ...params, delivery }).catch((error) => {
    console.error('[Fast Agent] Queued surface reply failed:', error);
  });
  return true;
}
