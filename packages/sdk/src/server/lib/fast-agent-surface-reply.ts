import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  createFastAgentWebTaskLauncher,
  FastAgentDurableRetryScheduledError,
  fastAgentConversationRepository,
  getActiveFastAgentTasks,
  resolveApiBaseUrl,
  type FastAgentActiveTask,
  type FastAgentConversation,
  type FastAgentReactionExternalInput,
  type FastAgentTurnAdapter,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  ensureSessionForFastConversation,
  eq,
  slackInstallations,
} from '@roomote/db/server';
import { isFastAgentSourceControlConversation } from '@roomote/types';
import {
  buildFastSessionReplyFooterText,
  deliverManagedThreadReplyFooter,
  getDiscordFooterlessFinalChunk,
  resolveFastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  createFastAgentSlackLiveTaskLauncher,
  createFastAgentSlackSessionActivity,
  postSlackThreadMessageWithFooterText,
  SlackNotifier,
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID,
} from '@roomote/slack';

import { createDiscordCommunicationProviderFromRuntimeCredentials } from './discord-communication';
import { createSlackFastReplyStream } from './fast-agent-slack-reply-stream';
import { findSlackConversationSubjectByUserId } from './slack-conversation-log';
import {
  createFastAgentCommunicationTaskLauncher,
  createFastAgentDiscordTaskLauncher,
} from './fast-agent-parent-event';
import { createTeamsCommunicationProviderFromRuntimeCredentials } from './teams-communication';
import { createTelegramCommunicationProviderFromRuntimeCredentials } from './telegram-communication';
import { findTeamsConversationRoute } from '../automations/destination';
import { recordFastAgentConversationMessageBestEffort } from './fast-agent-provider-message';
import {
  createDiscordFastReplyReplacer,
  createSlackFastReplyReplacer,
  createTeamsFastReplyReplacer,
  createTelegramFastReplyReplacer,
} from './fast-agent-reply-replacement';
import {
  admitFastAgentHumanFollowUp,
  persistFastAgentInlineHumanTurn,
} from './fast-agent-human-follow-up';
import {
  wakeFastAgentParentEventAt,
  wakeFastAgentParentEventNow,
} from './fast-agent-parent-event-queue';
import { resolveUserMcpServerConfigs } from '../routers/mcp-connections';
import {
  buildLinearFastReplyMessageId,
  createFastAgentLinearTaskLauncher,
  resolveLinearFastSessionClient,
} from './linear-fast-session';
import {
  buildSourceControlFastAdapter,
  buildSourceControlFastDelivery,
  buildSourceControlReplyQuote,
} from './source-control-fast-delivery';
import { createFastAgentSessionArtifact } from './artifacts/create-session-artifact';

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
    'activity' | 'createArtifact' | 'launchTask' | 'postReply' | 'replaceReply'
  >;
};

type FastAgentSurfaceReplyParams = {
  sessionId: string;
  userId: string;
  senderDisplayName: string | null;
  question: string;
  /** Surface context the model reads with this message, for example the
   * Linear issue a session belongs to. */
  agentContext?: string;
  currentMessageId: string;
  replyToMessageId?: string;
  images?: string[];
  /**
   * Tasks the Session may steer on this turn beyond the ones it delegated,
   * for example the task that already owns the pull request a comment is on.
   */
  activeTasks?: FastAgentActiveTask[];
  externalInput?: FastAgentReactionExternalInput;
  /**
   * Admission-time hooks for callers that must not block on the whole turn
   * (suggestion launchers finalize their claim as soon as the turn is
   * admitted). `onAccepted` fires once the follow-up is durably queued,
   * steered into a running turn, or owns the turn lock, with a callback that
   * aborts that admission; `onRejected` fires when the session refuses it.
   */
  onAccepted?: (abort: () => Promise<void>) => void;
  onRejected?: () => void;
};

// Sessions follow the same rules as tasks: every authenticated user of the
// deployment can read and reply to every conversation, so access reduces to
// the conversation existing. Replies stay attributed to the sending user.
export async function canUserAccessFastAgentSession(params: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const conversation = await fastAgentConversationRepository.findById({
    id: params.sessionId,
  });
  return conversation !== null;
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
    // Streaming a reply outside a DM needs the Slack user it is addressed
    // to; a sender without a linked Slack account gets whole replies.
    const senderSubject = await findSlackConversationSubjectByUserId({
      userId: params.userId,
      slackTeamId: conversation.workspaceId,
    }).catch(() => null);

    return {
      conversation,
      adapter: {
        ...(senderSubject
          ? {
              createReplyStream: () =>
                createSlackFastReplyStream({
                  slack,
                  conversation,
                  channelId: conversation.replyTarget.channelId,
                  threadTs: threadId,
                  recipientTeamId: conversation.workspaceId,
                  recipientUserId: senderSubject.subjectSlackUserId,
                  sessionId: session.id,
                  footerContext,
                  getQuote: () => pendingQuote,
                  onDelivered: () => {
                    pendingQuote = null;
                  },
                }),
            }
          : {}),
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
        replaceReply: createSlackFastReplyReplacer({
          slack,
          conversation,
          channelId: conversation.replyTarget.channelId,
          threadTs: threadId,
          sessionId: session.id,
          footerContext,
        }),
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

    const adapter: FastAgentTurnAdapter = {
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
        const footerStateThreadId = conversation.replyTarget.threadId ?? 'root';
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
    };
    adapter.replaceReply = createDiscordFastReplyReplacer({
      provider,
      conversation,
      channelId: conversation.replyTarget.channelId,
      threadId: conversation.replyTarget.threadId,
      sessionId: session.id,
      footerContext,
      postReplacement: (text) =>
        adapter.postReply({ purpose: 'closeout', message: text }),
    });
    return { conversation, adapter };
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
        replaceReply: createTeamsFastReplyReplacer({
          provider,
          conversation,
          channelId: conversation.replyTarget.channelId,
          serviceUrl,
          sessionId: session.id,
          footerContext,
        }),
      },
    };
  }

  if (conversation.surface === 'linear') {
    const linear = await resolveLinearFastSessionClient(
      conversation.workspaceId,
    );
    if (!linear) {
      return null;
    }
    const agentSessionId = conversation.replyTarget.channelId;
    return {
      conversation,
      adapter: {
        launchTask: createFastAgentLinearTaskLauncher({
          userId: params.userId,
          conversation,
          resolveIssue: () => linear.getAgentSessionIssue(agentSessionId),
        }),
        postReply: async ({ message }) => {
          const result = await linear.emitResponse(agentSessionId, message);
          if (!result.success) {
            throw new Error(
              result.error ?? 'Linear did not accept the agent response.',
            );
          }
          return { messageId: buildLinearFastReplyMessageId() };
        },
      },
    };
  }

  if (isFastAgentSourceControlConversation(conversation)) {
    const delivery = await buildSourceControlFastDelivery(conversation);
    if (!delivery) {
      return null;
    }
    return {
      conversation,
      adapter: buildSourceControlFastAdapter({
        conversation,
        delivery,
        userId: params.userId,
        sessionId: session.id,
        quote: params.externalInput
          ? null
          : buildSourceControlReplyQuote({ text: params.question }),
      }),
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
        replaceReply: createTelegramFastReplyReplacer({
          provider,
          conversation,
          channelId: conversation.replyTarget.channelId,
          sessionId: session.id,
          footerContext,
        }),
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
    params.onRejected?.();
    return false;
  }

  const admission = await admitFastAgentSurfaceHumanFollowUp(params, delivery);
  if (admission && admission.kind !== 'turn') {
    params.onAccepted?.(admission.abort);
    return true;
  }

  return runFastAgentSurfaceReply({ ...params, delivery, admission });
}

type FastAgentSurfaceHumanFollowUpAdmission = Awaited<
  ReturnType<typeof admitFastAgentHumanFollowUp>
> | null;

async function admitFastAgentSurfaceHumanFollowUp(
  params: FastAgentSurfaceReplyParams,
  delivery: FastAgentSurfaceReplyDelivery,
  forceQueue = false,
): Promise<FastAgentSurfaceHumanFollowUpAdmission> {
  // A reaction is admitted like a message so its row exists before the
  // webhook is acknowledged: inline under this owner's claim when the
  // conversation is idle, steered into the active turn otherwise. It is
  // never force-queued, because the reaction's reply targets the reacted-to
  // message and only the inline surface delivery knows how to do that.
  return admitFastAgentHumanFollowUp({
    parent: {
      sessionId: params.sessionId,
      conversation: delivery.conversation,
    },
    event: {
      type: 'human_follow_up',
      eventId: params.currentMessageId,
      currentMessageId: params.currentMessageId,
      userId: params.userId,
      question: params.question,
      ...(params.images?.length ? { images: params.images } : {}),
      ...(params.senderDisplayName
        ? { senderDisplayName: params.senderDisplayName }
        : {}),
      ...(params.externalInput
        ? {
            senderExternalId: params.externalInput.reactor.externalUserId,
            input: {
              type: 'reaction' as const,
              externalInput: params.externalInput,
            },
          }
        : {}),
    },
    forceQueue: forceQueue && !params.externalInput,
  });
}

async function runFastAgentSurfaceReply(
  params: FastAgentSurfaceReplyParams & {
    delivery: FastAgentSurfaceReplyDelivery;
    admission: FastAgentSurfaceHumanFollowUpAdmission;
  },
): Promise<boolean> {
  const { admission, delivery } = params;

  const release =
    (admission?.kind === 'turn' ? admission.turnLock : null) ??
    (await acquireFastAgentTurnLock({
      conversation: delivery.conversation,
    }));
  if (!release) {
    params.onRejected?.();
    return false;
  }
  params.onAccepted?.(() => release.abort());

  const apiBaseUrl = resolveApiBaseUrl() ?? undefined;
  try {
    const activeTasks = params.externalInput
      ? [
          ...(params.activeTasks ?? []),
          ...(await getActiveFastAgentTasks(params.sessionId)),
        ]
      : params.activeTasks;
    // Durable admission: persisted under this owner's claim before the turn
    // runs. A reaction rides the same row with its input recorded, so the
    // queue resumes it as a reaction turn rather than a typed message.
    const durableTurn =
      (admission?.kind === 'turn' ? admission.durable : null) ??
      (await persistFastAgentInlineHumanTurn({
        parent: {
          sessionId: params.sessionId,
          conversation: delivery.conversation,
        },
        event: {
          type: 'human_follow_up',
          eventId: params.currentMessageId,
          currentMessageId: params.currentMessageId,
          userId: params.userId,
          question: params.question,
          ...(params.images?.length ? { images: params.images } : {}),
          ...(params.senderDisplayName
            ? { senderDisplayName: params.senderDisplayName }
            : {}),
          ...(params.externalInput
            ? {
                senderExternalId: params.externalInput.reactor.externalUserId,
                input: {
                  type: 'reaction' as const,
                  externalInput: params.externalInput,
                },
              }
            : {}),
        },
      }).catch((error) => {
        console.error(
          `[Fast Agent] Failed to persist surface turn admission: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }));
    if (durableTurn) {
      release.durableRowId = durableTurn.id;
      release.durableResume = () =>
        wakeFastAgentParentEventNow({
          conversationId: params.sessionId,
          eventKey: durableTurn.eventKey,
        });
    }
    await answerFastAgentQuestion({
      question: params.question,
      images: params.images,
      ...(params.agentContext
        ? { currentMessageAgentContext: params.agentContext }
        : {}),
      userId: params.userId,
      apiBaseUrl,
      conversation: delivery.conversation,
      currentMessageId: params.currentMessageId,
      signal: release.signal,
      ...(durableTurn ? { durableAdmission: { eventId: durableTurn.id } } : {}),
      // A redelivered message whose earlier inline attempt never settled
      // resumes that attempt instead of repeating its recorded actions.
      ...(durableTurn?.resumed ? { resumedAfterInterruption: true } : {}),
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
        ...(durableTurn
          ? {
              requestDurableResume: () =>
                wakeFastAgentParentEventNow({
                  conversationId: params.sessionId,
                  eventKey: durableTurn.eventKey,
                }),
              requestDurableRetry: (retryAt: Date) =>
                wakeFastAgentParentEventAt(
                  {
                    conversationId: params.sessionId,
                    eventKey: durableTurn.eventKey,
                  },
                  retryAt,
                ),
            }
          : {}),
        createArtifact: async (artifact) => {
          const unifiedSession = await ensureSessionForFastConversation(
            db,
            params.sessionId,
          );
          return createFastAgentSessionArtifact({
            sessionId: unifiedSession.id,
            ...artifact,
          });
        },
        ...delivery.adapter,
      },
    }).catch((error: unknown) => {
      // Not a failure: the turn parked itself for a durable retry and the
      // queue re-runs it at the scheduled time, so the reply is on its way.
      if (error instanceof FastAgentDurableRetryScheduledError) {
        console.info(
          `[Fast Agent] Surface reply turn parked for a durable retry: ${error.message}`,
        );
        return;
      }
      throw error;
    });
    return true;
  } finally {
    await release().catch(() => {});
  }
}

export async function queueFastAgentSurfaceReply(
  params: FastAgentSurfaceReplyParams,
): Promise<boolean> {
  const delivery = await buildFastAgentSurfaceReplyDelivery(params);
  if (!delivery) return false;

  const admission = await admitFastAgentSurfaceHumanFollowUp(
    params,
    delivery,
    true,
  );
  // Queued messages and steered reactions are on record for the active or
  // next turn; only an inline admission still needs this process to run it.
  if (admission && admission.kind !== 'turn') return true;

  void runFastAgentSurfaceReply({ ...params, delivery, admission }).catch(
    (error) => {
      console.error('[Fast Agent] Queued surface reply failed:', error);
    },
  );
  return true;
}
