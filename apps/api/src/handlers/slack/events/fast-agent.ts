import { PRODUCT_NAME } from '@roomote/types';
import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
  type FastAgentActiveTask,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { type SlackEvent, type SlackNotifier } from '@roomote/slack';
import { stripLeadingSlackProductMention } from '@roomote/cloud-agents';

import { LEADING_FAST_COMMAND_MENTION_PATTERN } from '../constants.js';
import { postSlackThreadMarkdownMessage } from '../helpers/thread-posting.js';

export function stripLeadingFastCommandMention(text: string): string {
  return text.replace(LEADING_FAST_COMMAND_MENTION_PATTERN, '').trimStart();
}

export function isFastCommandInvocation(text: string): boolean {
  const mentionStrippedText = stripLeadingFastCommandMention(text);
  return /^(?:\/|!)fast(?:\s|$)/i.test(mentionStrippedText);
}

export function isBareFastCommandInvocation(text: string): boolean {
  return /^(?:\/|!)fast(?:\s|$)/i.test(text.trimStart());
}

export function extractFastQuestion(
  mentionStrippedText: string,
  continuation = false,
): string | null {
  if (continuation) {
    const trimmedQuestion = mentionStrippedText.trim();
    return trimmedQuestion.length > 0 ? trimmedQuestion : null;
  }

  const match = mentionStrippedText.match(/^(?:\/|!)fast\s*(.*)$/is);
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
  usageText?: string;
  continuation?: boolean;
  activeTasks?: FastAgentActiveTask[];
  launchTask: LaunchFastAgentTask;
  processingReactionName?: string;
  directedAtRoomote?: boolean;
}): Promise<void> {
  const {
    event,
    slack,
    userId,
    teamId,
    apiBaseUrl,
    usageText = `Use \`/fast <question>\` after mentioning ${PRODUCT_NAME}.`,
    continuation = false,
    activeTasks = [],
    launchTask,
    processingReactionName = 'eyes',
    directedAtRoomote = false,
  } = params;
  const threadId = event.thread_ts || event.ts;
  const conversation = {
    surface: 'slack' as const,
    workspaceId: teamId,
    conversationId: threadId,
    replyTarget: {
      channelId: event.channel,
      threadId,
    },
  };
  const releaseFastAgentLock = await acquireFastAgentTurnLock({
    conversation,
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
  const question = extractFastQuestion(normalizedText, continuation);

  let didAddProcessingReaction = false;

  try {
    if (!question) {
      didAddProcessingReaction = await slack.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: processingReactionName,
      });
      await postSlackThreadMarkdownMessage({
        slack,
        channel: event.channel,
        threadTs: threadId,
        text: usageText,
        sourceMessageTs: event.ts,
        conversationLog: {
          userId,
          slackTeamId: teamId,
          source: 'fast_agent',
        },
      });
      return;
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
    const multiParticipantThread = threadContext.some(
      (message) =>
        message.ts !== event.ts &&
        !message.bot_id &&
        Boolean(message.user) &&
        message.user !== event.user,
    );

    if (!multiParticipantThread) {
      didAddProcessingReaction = await slack.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: processingReactionName,
      });
    }

    const serializedThreadContext = threadContext
      .filter((message) => message.ts !== event.ts)
      .map((message) => ({
        user: message.user,
        username: message.username,
        text: message.text,
        ts: message.ts,
        bot_id: message.bot_id,
      }));

    const responseText = await answerFastAgentQuestion({
      question,
      currentMessageAgentContext: event.agentContext,
      threadContext: serializedThreadContext,
      userId,
      apiBaseUrl,
      conversation,
      currentMessageId: event.ts,
      senderExternalId: event.user,
      senderDisplayName:
        currentMessage?.user === event.user
          ? currentMessage.username
          : undefined,
      activeTasks,
      multiParticipantThread,
      directedAtRoomote,
      adapter: {
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
    await releaseFastAgentLock().catch(() => {});
  }
}
