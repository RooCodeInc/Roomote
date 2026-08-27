import {
  getOrCreateFastAgentSession,
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  hasFastAgentSession,
  type FastAgentActiveTask,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { buildFastSessionReplyFooterText } from '@roomote/communication';
import {
  acquireSlackFastRootBindingLock,
  buildSlackThreadReplyFooterBlock,
  getSlackThreadReplyFooterMessageTs,
  withSlackThreadReplyFooterLock,
  resolveCurrentSlackMessageFiles,
  type SlackEvent,
  type SlackNotifier,
} from '@roomote/slack';
import { stripLeadingSlackProductMention } from '@roomote/cloud-agents';
import { resolveUserMcpServerConfigs } from '@roomote/sdk/server';

import { LEADING_FAST_COMMAND_MENTION_PATTERN } from '../constants.js';
import { postSlackThreadMarkdownMessage } from '../helpers/thread-posting.js';

export function stripLeadingFastCommandMention(text: string): string {
  return text.replace(LEADING_FAST_COMMAND_MENTION_PATTERN, '').trimStart();
}

export function isFastCommandInvocation(text: string): boolean {
  const mentionStrippedText = stripLeadingFastCommandMention(text);
  return /^!fast(?:\s|$)/i.test(mentionStrippedText);
}

export function isBareFastCommandInvocation(text: string): boolean {
  return /^!fast(?:\s|$)/i.test(text.trimStart());
}

export function extractFastQuestion(
  mentionStrippedText: string,
  continuation = false,
): string | null {
  if (continuation) {
    const trimmedQuestion = mentionStrippedText.trim();
    return trimmedQuestion.length > 0 ? trimmedQuestion : null;
  }

  const match = mentionStrippedText.match(/^!fast\s*(.*)$/is);
  if (!match) {
    return null;
  }

  const [, question = ''] = match;
  const trimmedQuestion = question.trim();

  return trimmedQuestion.length > 0 ? trimmedQuestion : null;
}

export async function processFastAgentMessage(params: {
  event: SlackEvent;
  slack: SlackNotifier;
  userId: string;
  teamId: string;
  apiBaseUrl?: string;
  continuation?: boolean;
  activeTasks?: FastAgentActiveTask[];
  resolveActiveTasks?: () => Promise<FastAgentActiveTask[]>;
  launchTask: LaunchFastAgentTask;
  processingReactionName?: string;
  isExistingConversation?: boolean;
}): Promise<void> {
  const {
    event,
    slack,
    userId,
    teamId,
    apiBaseUrl,
    continuation = false,
    activeTasks = [],
    resolveActiveTasks,
    launchTask,
    processingReactionName = 'eyes',
    isExistingConversation = false,
  } = params;
  const threadId = event.thread_ts || event.ts;
  const incomingConversation = {
    surface: 'slack' as const,
    workspaceId: teamId,
    conversationId: threadId,
    replyTarget: {
      channelId: event.channel,
      threadId,
    },
  };
  const releaseFastAgentLock = await acquireFastAgentTurnLock({
    conversation: incomingConversation,
  });

  if (!releaseFastAgentLock) {
    console.error(
      `[SlackWebhook] Fast turn lock did not become available for ${teamId}:${event.channel}:${threadId}`,
    );
    return;
  }

  const normalizedText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(
      stripLeadingFastCommandMention(event.authoredText ?? event.text),
    ),
  );
  const question = extractFastQuestion(normalizedText, continuation) ?? '';

  let didAddProcessingReaction = false;
  let releaseCanonicalFastAgentLock: Awaited<
    ReturnType<typeof acquireFastAgentTurnLock>
  > = null;

  try {
    // Resolve route-based aliases only after serializing the inbound Slack
    // thread. Delayed automation roots retain their original conversation
    // identity, so their canonical session has a separate turn lock.
    const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
      teamId,
      channelId: event.channel,
    });
    const { hasExistingConversation, session } = await (async () => {
      try {
        return {
          hasExistingConversation:
            isExistingConversation ||
            (await hasFastAgentSession(incomingConversation)),
          session: await getOrCreateFastAgentSession({
            userId,
            conversation: incomingConversation,
          }),
        };
      } finally {
        await releaseRootBindingLock().catch(() => {});
      }
    })();
    const conversation = session.conversation;
    if (
      conversation.surface !== incomingConversation.surface ||
      conversation.workspaceId !== incomingConversation.workspaceId ||
      conversation.conversationId !== incomingConversation.conversationId
    ) {
      releaseCanonicalFastAgentLock = await acquireFastAgentTurnLock({
        conversation,
      });
      if (!releaseCanonicalFastAgentLock) {
        console.error(
          `[SlackWebhook] Canonical Fast turn lock did not become available for session ${session.id}`,
        );
        return;
      }
    }

    if (!hasExistingConversation) {
      didAddProcessingReaction = await slack.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: processingReactionName,
      });
    }

    let threadContext: Awaited<ReturnType<typeof slack.fetchThreadMessages>> =
      [];

    try {
      threadContext = await slack.fetchThreadMessages({
        channel: event.channel,
        threadTs: threadId,
      });
    } catch (error) {
      console.error(
        `[SlackWebhook] Failed to fetch thread context for fast agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let didSendVisibleResponse = false;
    const currentMessage = threadContext.find(
      (message) => message.ts === event.ts,
    );
    const currentMessageFiles = resolveCurrentSlackMessageFiles({
      currentMessageTs: event.ts,
      eventFiles: event.files,
      messages: threadContext,
    });
    const images = currentMessageFiles?.length
      ? await slack.processSlackFiles(currentMessageFiles).catch((error) => {
          console.error(
            `[SlackWebhook] Failed to process Fast message images: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        })
      : [];
    const serializedThreadContext = threadContext
      .filter((message) => message.ts !== event.ts)
      .map((message) => ({
        user: message.user,
        username: message.username,
        text: message.text,
        ts: message.ts,
        bot_id: message.bot_id,
      }));

    const resolvedActiveTasks = resolveActiveTasks
      ? await resolveActiveTasks()
      : activeTasks;
    const responseText = await answerFastAgentQuestion({
      question,
      images,
      currentMessageAgentContext: event.agentContext,
      threadContext: serializedThreadContext,
      userId,
      apiBaseUrl,
      conversation,
      currentMessageId: event.ts,
      signal: (releaseCanonicalFastAgentLock ?? releaseFastAgentLock).signal,
      senderExternalId: event.user,
      senderDisplayName:
        currentMessage?.user === event.user
          ? currentMessage.username
          : undefined,
      activeTasks: resolvedActiveTasks,
      adapter: {
        resolveMcpServerConfigs: () =>
          resolveUserMcpServerConfigs({
            userId,
            apiBaseUrl,
            includeRoomoteMemberTools: true,
          }),
        launchTask,
        postReply: async ({ message, kickoff }) => {
          const posted = await postSlackThreadMarkdownMessage({
            slack,
            channel: event.channel,
            threadTs: threadId,
            text: message,
            sourceMessageTs: event.ts,
            conversationLog: {
              userId,
              slackTeamId: teamId,
              source: 'fast_agent',
            },
            fastSessionFooter: { sessionId: session.id },
          });
          if (posted === 'failed') {
            throw new Error('Slack did not accept the Fast parent reply.');
          }
          if (posted === 'suppressed' && kickoff) {
            // The launch gate requires a visible, durable parent kickoff
            // before the child becomes runnable; a suppressed kickoff must
            // abort the launch instead of opening the gate silently.
            throw new Error(
              'The Fast kickoff was suppressed because the triggering message was deleted.',
            );
          }
          // Suppression of an ordinary reply is deliberate (the triggering
          // message was deleted); treat it as delivered so the turn is not
          // aborted mid-flight.
          didSendVisibleResponse = true;
          return typeof posted === 'object'
            ? { messageId: posted.messageId }
            : undefined;
        },
        replaceReply: async ({ messageId }, { message }) => {
          // Keep the sticky footer when the edited message is its current
          // carrier; the lookup and edit share the footer lock so a
          // concurrent relocation cannot slip in between them.
          const updated = await withSlackThreadReplyFooterLock({
            channel: event.channel,
            threadTs: threadId,
            fn: async () => {
              const footerMessageTs = await getSlackThreadReplyFooterMessageTs(
                event.channel,
                threadId,
              ).catch(() => null);
              return slack.updateMessage({
                channel: event.channel,
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
            throw new Error('Slack did not update the Fast parent reply.');
          }
          didSendVisibleResponse = true;
          return { messageId };
        },
        postReaction: async ({ name, purpose, messageId }) => {
          if (
            didAddProcessingReaction &&
            name === processingReactionName &&
            messageId === event.ts
          ) {
            if (purpose === 'closeout') {
              didAddProcessingReaction = false;
            }
            didSendVisibleResponse = true;
            return;
          }

          const added = await slack.addReaction({
            channel: event.channel,
            timestamp: messageId,
            name,
          });
          if (!added) {
            throw new Error(`Slack rejected the ${name} reaction.`);
          }
          didSendVisibleResponse = true;
        },
      },
    });

    if (responseText.length > 0 && !didSendVisibleResponse) {
      await postSlackThreadMarkdownMessage({
        slack,
        channel: event.channel,
        threadTs: threadId,
        text: responseText,
        sourceMessageTs: event.ts,
        conversationLog: {
          userId,
          slackTeamId: teamId,
          source: 'fast_agent',
        },
        fastSessionFooter: { sessionId: session.id },
      });
    }
  } finally {
    if (didAddProcessingReaction) {
      await slack
        .removeReaction({
          channel: event.channel,
          timestamp: event.ts,
          name: processingReactionName,
        })
        .catch(() => {});
    }
    await releaseCanonicalFastAgentLock?.().catch(() => {});
    await releaseFastAgentLock().catch(() => {});
  }
}
