import { acquireRedisLock } from '@roomote/redis';
import { PRODUCT_NAME } from '@roomote/types';
import { answerFastAgentQuestion } from '@roomote/cloud-agents/server';
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
  return /^!fast(?:\s|$)/i.test(mentionStrippedText);
}

export function isBareFastCommandInvocation(text: string): boolean {
  return /^!fast(?:\s|$)/i.test(text.trimStart());
}

function extractFastQuestion(mentionStrippedText: string): string | null {
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
  ackEmoji: string;
  usageText?: string;
}): Promise<void> {
  const {
    event,
    slack,
    userId,
    teamId,
    apiBaseUrl,
    ackEmoji,
    usageText = `Use \`!fast <question>\` after mentioning ${PRODUCT_NAME}.`,
  } = params;
  const threadId = event.thread_ts || event.ts;
  const releaseFastAgentLock = await acquireRedisLock(
    `${SLACK_FAST_AGENT_LOCK_PREFIX}${threadId}`,
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

  await slack.addReaction({
    channel: event.channel,
    timestamp: event.ts,
    name: ackEmoji,
  });

  const normalizedText = stripLeadingSlackProductMention(
    await slack.normalizeIncomingText(
      stripLeadingFastCommandMention(event.text),
    ),
  );
  const question = extractFastQuestion(normalizedText);

  try {
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

    let didFailToReplyToSlack = false;
    let didPostFinalAnswer = false;
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
      slackChannel: event.channel,
      slackThreadTs: threadId,
      currentMessageTs: event.ts,
      postSlackReply: async ({ type, text }) => {
        try {
          const posted = await postSlackThreadMarkdownMessage({
            slack,
            channel: event.channel,
            threadTs: threadId,
            text,
            sourceMessageTs: event.ts,
            conversationLog: {
              userId,
              slackTeamId: teamId,
              source: 'fast_agent',
            },
          });
          if (posted && type === 'final_answer') {
            didPostFinalAnswer = true;
          }
        } catch (error) {
          didFailToReplyToSlack = true;
          throw error;
        }
      },
    });

    if (
      responseText.length > 0 &&
      (didFailToReplyToSlack || !didPostFinalAnswer)
    ) {
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
    await slack
      .removeReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: ackEmoji,
      })
      .catch(() => {});
    await releaseFastAgentLock().catch(() => {});
  }
}
