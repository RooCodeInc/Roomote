import type { ModelMessage } from 'ai';
import { formatErrorForLog } from '@roomote/types';

import {
  buildSlackThreadPromptBlocks,
  wrapSlackMessage,
  wrapSlackThreadContext,
  type SlackThreadPromptMessage,
} from '../../utils';
import { getAvailableEnvironments, type RoutableEnvironment } from '../router';
import { FAST_AGENT_MAX_STEPS, FAST_AGENT_MODEL } from './fast-agent-constants';
import { buildFastAgentSystemPrompt } from './fast-agent-prompt';
import {
  appendFastAgentSessionMessages,
  getOrCreateFastAgentSession,
} from './fast-agent-session';
import {
  generateTrackedNonTaskText,
  NON_TASK_INFERENCE_SURFACES,
} from '../non-task-provider-usage';

export type FastAgentSlackThreadMessage = SlackThreadPromptMessage;

interface FastAgentSlackReply {
  type: 'ack' | 'final_answer';
  slackChannel: string;
  slackThreadTs: string;
  text: string;
}

type PostFastAgentSlackReply = (reply: FastAgentSlackReply) => Promise<void>;

function normalizeThreadText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildUserTextMessage(text: string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

function buildAssistantTextMessage(text: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

function extractModelMessageText(message: ModelMessage): string[] {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return [];
  }

  if (typeof message.content === 'string') {
    return [message.content];
  }

  return message.content.flatMap((part) =>
    part.type === 'text' ? [part.text] : [],
  );
}

function buildSupplementalSlackThreadContext({
  question,
  threadContext,
  sessionMessages,
}: {
  question: string;
  threadContext: FastAgentSlackThreadMessage[];
  sessionMessages: ModelMessage[];
}): string | undefined {
  const persistedMessageCounts = new Map<string, number>();

  for (const message of sessionMessages) {
    for (const text of extractModelMessageText(message)) {
      const normalizedText = normalizeThreadText(text);
      if (normalizedText.length === 0) {
        continue;
      }

      const key = `${message.role}:${normalizedText}`;
      persistedMessageCounts.set(
        key,
        (persistedMessageCounts.get(key) ?? 0) + 1,
      );
    }
  }

  const normalizedQuestion = normalizeThreadText(question);

  return wrapSlackThreadContext(
    threadContext
      .filter((message) => {
        const normalizedText = normalizeThreadText(message.text);
        if (
          normalizedText.length === 0 ||
          normalizedText === normalizedQuestion
        ) {
          return false;
        }

        const role = message.bot_id ? 'assistant' : 'user';
        const key = `${role}:${normalizedText}`;
        const remainingCount = persistedMessageCounts.get(key) ?? 0;

        if (remainingCount > 0) {
          persistedMessageCounts.set(key, remainingCount - 1);
          return false;
        }

        return true;
      })
      .map((message) => ({
        displayName: message.username?.trim() || message.user,
        text: message.text,
        ts: message.ts,
      })),
  );
}

function buildFastAgentMessages({
  question,
  threadContext,
  sessionMessages,
  currentMessageTs,
}: {
  question: string;
  threadContext: FastAgentSlackThreadMessage[];
  sessionMessages: ModelMessage[];
  currentMessageTs?: string;
}): ModelMessage[] {
  const normalizedQuestion = normalizeThreadText(question);
  const currentUserMessageText = currentMessageTs
    ? wrapSlackMessage(normalizedQuestion, { ts: currentMessageTs })
    : normalizedQuestion;
  const serializedThreadContext = threadContext;
  const serializedSessionMessages = sessionMessages;

  if (serializedSessionMessages.length > 0) {
    const supplementalThreadContext = buildSupplementalSlackThreadContext({
      question,
      threadContext: serializedThreadContext,
      sessionMessages,
    });

    return [
      ...serializedSessionMessages,
      ...(supplementalThreadContext
        ? [buildUserTextMessage(supplementalThreadContext)]
        : []),
      buildUserTextMessage(currentUserMessageText),
    ];
  }

  const { threadContext: slackThreadContext, replyingTo } = currentMessageTs
    ? buildSlackThreadPromptBlocks({
        threadMessages: serializedThreadContext,
        currentMessageTs,
      })
    : {
        threadContext: wrapSlackThreadContext(
          serializedThreadContext.map((message) => ({
            displayName: message.username?.trim() || message.user,
            text: message.text,
            ts: message.ts,
          })),
        ),
        replyingTo: undefined,
      };
  const text = [slackThreadContext, replyingTo, currentUserMessageText]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');

  return [buildUserTextMessage(text)];
}

async function persistFastAgentSessionMessages({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: ModelMessage[];
}) {
  try {
    await appendFastAgentSessionMessages({ sessionId, messages });
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to persist session messages: ${formatErrorForLog(error)}`,
    );
  }
}

function serializeFastAgentMessages(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content
            .map((part) => {
              if (part.type === 'text') {
                return part.text;
              }

              return `[${part.type} attachment omitted]`;
            })
            .join('\n')
        : String(message.content);

      return `[${message.role.toUpperCase()}]\n${content}`;
    })
    .join('\n\n');
}

export async function answerFastAgentQuestion({
  question,
  threadContext = [],
  userId,
  apiBaseUrl: _apiBaseUrl,
  slackChannel,
  slackThreadTs,
  currentMessageTs,
  postSlackReply,
}: {
  question: string;
  threadContext?: FastAgentSlackThreadMessage[];
  userId: string;
  apiBaseUrl?: string;
  slackChannel: string;
  slackThreadTs: string;
  currentMessageTs?: string;
  postSlackReply: PostFastAgentSlackReply;
}): Promise<string> {
  let sessionId: string | null = null;
  const normalizedQuestion = normalizeThreadText(question);
  const userMessage = buildUserTextMessage(normalizedQuestion);

  try {
    const [availableEnvironments, session] = await Promise.all([
      getAvailableEnvironments(),
      getOrCreateFastAgentSession({
        userId,
        slackChannel,
        slackThreadTs,
      }),
    ]);
    sessionId = session.id;
    const fastAgentMessages = buildFastAgentMessages({
      question,
      threadContext,
      sessionMessages: session.messages,
      currentMessageTs,
    });
    const text = await generateTrackedNonTaskText({
      userId,
      surface: NON_TASK_INFERENCE_SURFACES.fastAgentQuestionAnswering,
      system: buildFastAgentSystemPrompt({
        availableEnvironments,
        hasGitHubTools: false,
      }),
      prompt: serializeFastAgentMessages(fastAgentMessages),
    });

    const responseText = text.trim();
    await persistFastAgentSessionMessages({
      sessionId: session.id,
      messages: [userMessage, buildAssistantTextMessage(responseText)],
    });
    await postSlackReply({
      type: 'final_answer',
      slackChannel,
      slackThreadTs,
      text: responseText,
    });

    return responseText;
  } catch (error) {
    console.error(
      `[Fast Agent] Failed to answer question: ${formatErrorForLog(error)}`,
    );
    const message =
      'I hit an error while handling that request. Please try again in a moment.';

    if (sessionId) {
      await persistFastAgentSessionMessages({
        sessionId,
        messages: [userMessage, buildAssistantTextMessage(message)],
      });
    }

    return message;
  }
}

export { FAST_AGENT_MAX_STEPS, FAST_AGENT_MODEL };
export type { RoutableEnvironment };
