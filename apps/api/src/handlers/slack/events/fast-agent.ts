import { acquireRedisLock } from '@roomote/redis';
import { PRODUCT_NAME } from '@roomote/types';
import {
  answerFastAgentQuestion,
  type LaunchFastAgentSlackTask,
} from '@roomote/cloud-agents/server';
import { type SlackEvent, type SlackNotifier } from '@roomote/slack';
import { stripLeadingSlackProductMention } from '@roomote/cloud-agents';

import {
  FAST_AGENT_LOCK_TTL_SECONDS,
  LEADING_FAST_COMMAND_MENTION_PATTERN,
  SLACK_FAST_AGENT_LOCK_PREFIX,
} from '../constants.js';
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
  activeTaskId?: string | null;
  launchTask?: LaunchFastAgentSlackTask;
  processingReactionName?: string;
}): Promise<void> {
  const {
    event,
    slack,
    userId,
    teamId,
    apiBaseUrl,
    usageText = `Use \`/fast <question>\` after mentioning ${PRODUCT_NAME}.`,
    continuation = false,
    activeTaskId = null,
    launchTask,
    processingReactionName = 'eyes',
  } = params;
  const threadId = event.thread_ts || event.ts;
  const releaseFastAgentLock = await acquireRedisLock(
    `${SLACK_FAST_AGENT_LOCK_PREFIX}${teamId}:${event.channel}:${threadId}`,
    { ttlSeconds: FAST_AGENT_LOCK_TTL_SECONDS },
  );

  if (!releaseFastAgentLock) {
    await postSlackThreadMarkdownMessage({
      slack,
      channel: event.channel,
      threadTs: threadId,
      text: "I'm already working on a question in this thread - please wait.",
      sourceMessageTs: event.ts,
      conversationLog: {
        userId,
        slackTeamId: teamId,
        source: 'fast_agent',
      },
    });
    return;
  }

  const normalizedText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(
      stripLeadingFastCommandMention(event.text),
    ),
  );
  const question = extractFastQuestion(normalizedText, continuation);

  let didAddProcessingReaction = false;

  try {
    didAddProcessingReaction = await slack.addReaction({
      channel: event.channel,
      timestamp: event.ts,
      name: processingReactionName,
    });

    if (!question) {
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
      threadContext: serializedThreadContext,
      userId,
      apiBaseUrl,
      slackTeamId: teamId,
      slackChannel: event.channel,
      slackThreadTs: threadId,
      currentMessageTs: event.ts,
      senderDisplayName: currentMessage?.username,
      activeTaskId,
      launchTask,
      postSlackReply: async ({ message }) => {
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
        if (posted) {
          didSendVisibleResponse = true;
        }
      },
      postSlackReaction: async ({ name, purpose, slackMessageTs }) => {
        if (
          didAddProcessingReaction &&
          name === processingReactionName &&
          slackMessageTs === event.ts
        ) {
          if (purpose === 'closeout') {
            didAddProcessingReaction = false;
          }
          didSendVisibleResponse = true;
          return;
        }

        const added = await slack.addReaction({
          channel: event.channel,
          timestamp: slackMessageTs,
          name,
        });
        if (!added) {
          throw new Error(`Slack rejected the ${name} reaction.`);
        }
        didSendVisibleResponse = true;
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
