import type { ModelMessage } from 'ai';
import { boundIntegrationToolReadContent } from '@roomote/types';

import {
  FAST_AGENT_REACTION_INPUT_TYPE,
  type FastAgentTurnSource,
} from './fast-agent-conversation';

const MAX_HISTORY_MESSAGES_TO_SCAN = 80;
const MAX_SESSION_USER_MESSAGES = 8;
const MAX_SESSION_USER_MESSAGE_LENGTH = 1_500;
const MAX_SESSION_USER_CONTEXT_LENGTH = 6_000;

function substantiveHumanMessageText(
  message: ModelMessage,
): string | undefined {
  if (message.role !== 'user') return undefined;
  const metadata = (message as { metadata?: unknown }).metadata;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    (metadata as Record<string, unknown>).turnSource !== 'human' ||
    (metadata as Record<string, unknown>).inputKind ===
      FAST_AGENT_REACTION_INPUT_TYPE
  ) {
    return undefined;
  }

  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n');
  const trimmed = text.trim();
  return trimmed || undefined;
}

/**
 * Bounded human-authored context for one Session's Auto judgment. Assistant,
 * tool, platform-event, and reaction messages are not user consent and are
 * omitted. Newest messages win when either cap is reached.
 */
export function resolveFastAgentToolApprovalSessionUserMessages(input: {
  turnSource: FastAgentTurnSource;
  substantiveHumanInput: boolean;
  question: string;
  compatibilityMessages: ModelMessage[];
  steeredHumanRequests: string[];
}): string[] {
  const history = input.compatibilityMessages
    .slice(-MAX_HISTORY_MESSAGES_TO_SCAN)
    .flatMap((message) => {
      const text = substantiveHumanMessageText(message);
      return text ? [text] : [];
    });
  const currentUserMessages = [
    ...(input.turnSource !== 'platform_event' && input.substantiveHumanInput
      ? [input.question]
      : []),
    ...input.steeredHumanRequests,
  ];

  let remaining = MAX_SESSION_USER_CONTEXT_LENGTH;
  const selected: string[] = [];
  for (const rawText of [...history, ...currentUserMessages].reverse()) {
    if (selected.length >= MAX_SESSION_USER_MESSAGES || remaining <= 0) {
      break;
    }
    // User text can still contain pasted credentials. Use the same bounded
    // secret masking as tool-result context before sending it to the judge.
    const text = boundIntegrationToolReadContent(rawText)
      .trim()
      .slice(0, MAX_SESSION_USER_MESSAGE_LENGTH);
    if (!text) continue;
    const bounded = text.slice(0, remaining);
    if (!bounded) break;
    selected.push(bounded);
    remaining -= bounded.length;
  }
  return selected.reverse();
}

/** Select human-only request context for integration-tool judgments. */
export function resolveFastAgentToolApprovalUserRequest(input: {
  turnSource: FastAgentTurnSource;
  substantiveHumanInput: boolean;
  question: string;
  compatibilityMessages: ModelMessage[];
  steeredHumanRequests: string[];
}): string | undefined {
  if (input.turnSource === 'platform_event') {
    // The event text is not a request; the latest human message is, plus
    // any human follow-up steered into this turn.
    let latestHumanRequest: string | undefined;
    for (
      let index = input.compatibilityMessages.length - 1;
      index >= 0 && !latestHumanRequest;
      index -= 1
    ) {
      latestHumanRequest = substantiveHumanMessageText(
        input.compatibilityMessages[index]!,
      );
    }
    return joinRequests([latestHumanRequest, ...input.steeredHumanRequests]);
  }

  if (!input.substantiveHumanInput) return undefined;
  return joinRequests([input.question, ...input.steeredHumanRequests]);
}

function joinRequests(requests: Array<string | undefined>): string | undefined {
  const present = requests
    .map((request) => request?.trim())
    .filter((request): request is string => Boolean(request));
  return present.length > 0 ? present.join('\n\n') : undefined;
}
