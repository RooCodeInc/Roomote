import { Env } from '@roomote/env';
import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  buildFastAgentReactionExternalInputQuestion,
  fastAgentConversationRepository,
  getActiveFastAgentTasks,
  type FastAgentReactionExternalInput,
} from '@roomote/cloud-agents/server';
import {
  buildFastSessionReplyFooterText,
  resolveFastSessionReplyFooterContext,
} from '@roomote/communication';
import {
  findFastAgentSessionForProviderMessage,
  recordFastAgentConversationMessageBestEffort,
  resolveUserMcpServerConfigs,
} from '@roomote/sdk/server';
import {
  buildSlackThreadReplyFooterBlock,
  createFastAgentSlackLiveTaskLauncher,
  createFastAgentSlackSessionActivity,
  getSlackThreadReplyFooterMessageTs,
  type SlackReactionAddedEvent,
  withSlackThreadReplyFooterLock,
} from '@roomote/slack';

import { startAcceptedFastAgentTurn } from '../../fast-agent-entry.js';
import type { SlackWebhookContext } from '../context.js';
import { postSlackThreadMarkdownMessage } from '../helpers/thread-posting.js';
import { lookupSlackUserMapping } from '../helpers/user-mapping.js';

async function processFastAgentReaction(params: {
  context: SlackWebhookContext;
  event: SlackReactionAddedEvent;
  session: NonNullable<
    Awaited<ReturnType<typeof findFastAgentSessionForProviderMessage>>
  >;
  targetMessage: { text: string; thread_ts?: string };
  reactorDisplayName?: string;
  onAccepted: (abort: () => Promise<void>) => void;
  onRejected: () => void;
}): Promise<void> {
  const { context, event, session } = params;
  const conversation = session.conversation;
  if (conversation.surface !== 'slack') {
    params.onRejected();
    return;
  }

  const threadTs = conversation.replyTarget.threadId;
  if (!threadTs) {
    params.onRejected();
    return;
  }

  const releaseTurnLock = await acquireFastAgentTurnLock({ conversation });
  if (!releaseTurnLock) {
    params.onRejected();
    return;
  }
  params.onAccepted(() =>
    releaseTurnLock.abort(new Error('Slack reaction turn was canceled.')),
  );

  const reactionInput: FastAgentReactionExternalInput = {
    type: 'reaction_added',
    provider: 'slack',
    reactions: [{ name: event.reaction }],
    reactor: {
      externalUserId: event.user,
      ...(params.reactorDisplayName
        ? { displayName: params.reactorDisplayName }
        : {}),
    },
    message: {
      workspaceId: context.teamId,
      channelId: event.item.channel,
      messageId: event.item.ts,
      threadId: threadTs,
      text: params.targetMessage.text,
    },
    eventId: event.event_ts,
  };

  try {
    const activeTasks = await getActiveFastAgentTasks(session.id);
    const footerContext = await resolveFastSessionReplyFooterContext({
      taskIds: activeTasks.map((task) => task.taskId),
    });
    let didSendVisibleResponse = false;

    const responseText = await answerFastAgentQuestion({
      question: buildFastAgentReactionExternalInputQuestion(reactionInput),
      userId: session.userId,
      conversation,
      currentMessageId: `slack-reaction:${event.event_ts}`,
      senderExternalId: event.user,
      senderDisplayName: params.reactorDisplayName,
      activeTasks,
      apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
      signal: releaseTurnLock.signal,
      turnSource: 'human',
      inputKind: 'reaction',
      responseVisibility: 'optional',
      currentMessageReactable: false,
      turnTranscriptPayload: { externalInput: reactionInput },
      adapter: {
        activity: createFastAgentSlackSessionActivity({
          slack: context.slack,
          workspaceId: context.teamId,
          channel: event.item.channel,
          threadTs,
          title: session.title,
          resolveTitle: async () =>
            (await fastAgentConversationRepository.findById({ id: session.id }))
              ?.title,
        }),
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId: session.userId,
            apiBaseUrl: Env.TRPC_URL ?? Env.R_APP_URL,
            includeRoomoteMemberTools: true,
          }),
        launchTask: createFastAgentSlackLiveTaskLauncher({
          slack: context.slack,
          userId: session.userId,
          teamId: context.teamId,
          ...(context.slackInstallation.teamDomain
            ? { teamDomain: context.slackInstallation.teamDomain }
            : {}),
          channelId: event.item.channel,
          threadTs,
          messageId: event.item.ts,
        }),
        postReply: async ({ message, kickoff }) => {
          const posted = await postSlackThreadMarkdownMessage({
            slack: context.slack,
            channel: event.item.channel,
            threadTs,
            text: message,
            sourceMessageTs: event.item.ts,
            conversationLog: {
              userId: session.userId,
              slackTeamId: context.teamId,
              source: 'fast_agent',
            },
            fastSessionFooter: { sessionId: session.id, ...footerContext },
          });
          if (posted === 'failed') {
            throw new Error('Slack did not accept the Fast reaction reply.');
          }
          if (posted === 'suppressed' && kickoff) {
            throw new Error(
              'The Fast kickoff was suppressed because the reacted-to message was deleted.',
            );
          }
          didSendVisibleResponse = posted !== 'suppressed';
          if (typeof posted !== 'object') return undefined;
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId: posted.messageId,
          });
          return { messageId: posted.messageId };
        },
        replaceReply: async ({ messageId }, { message }) => {
          const updated = await withSlackThreadReplyFooterLock({
            channel: event.item.channel,
            threadTs,
            fn: async () => {
              const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
                event.item.channel,
                threadTs,
              ).catch(() => null);
              return context.slack.updateMessage({
                channel: event.item.channel,
                ts: messageId,
                message: {
                  text: message,
                  blocks: [
                    { type: 'markdown', text: message },
                    ...(footerMessageTs === messageId
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
            throw new Error('Slack did not update the Fast reaction reply.');
          }
          didSendVisibleResponse = true;
          await recordFastAgentConversationMessageBestEffort({
            sessionId: session.id,
            conversation,
            messageId,
          });
          return { messageId };
        },
      },
    });

    if (responseText.length > 0 && !didSendVisibleResponse) {
      const posted = await postSlackThreadMarkdownMessage({
        slack: context.slack,
        channel: event.item.channel,
        threadTs,
        text: responseText,
        sourceMessageTs: event.item.ts,
        conversationLog: {
          userId: session.userId,
          slackTeamId: context.teamId,
          source: 'fast_agent',
        },
        fastSessionFooter: { sessionId: session.id, ...footerContext },
      });
      if (typeof posted === 'object') {
        await recordFastAgentConversationMessageBestEffort({
          sessionId: session.id,
          conversation,
          messageId: posted.messageId,
        });
      }
    }
  } finally {
    await releaseTurnLock().catch(() => {});
  }
}

export async function maybeRouteFastAgentReaction(params: {
  context: SlackWebhookContext;
  event: SlackReactionAddedEvent;
}): Promise<boolean> {
  const { context, event } = params;
  const { activeMapping } = await lookupSlackUserMapping({
    slackUserId: event.user,
    teamId: context.teamId,
  });
  if (!activeMapping) return false;

  const session = await findFastAgentSessionForProviderMessage({
    provider: 'slack',
    workspaceId: context.teamId,
    channelId: event.item.channel,
    messageId: event.item.ts,
    userId: activeMapping.userId,
  });
  if (!session) return false;

  const targetMessage = await context.slack.getMessage({
    channel: event.item.channel,
    messageTs: event.item.ts,
  });
  if (!targetMessage) return true;

  const reactorDisplayName = await context.slack
    .normalizeIncomingText(`<@${event.user}>`)
    .catch(() => undefined);
  await startAcceptedFastAgentTurn({
    run: ({ onAccepted, onRejected }) =>
      processFastAgentReaction({
        context,
        event,
        session,
        targetMessage,
        reactorDisplayName,
        onAccepted,
        onRejected,
      }),
    onError: (error) => {
      console.error(
        `[SlackWebhook] Fast reaction input failed for ${event.item.channel}:${event.item.ts}:`,
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  return true;
}
