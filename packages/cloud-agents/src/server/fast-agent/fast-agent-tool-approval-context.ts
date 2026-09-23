import type { ModelMessage } from 'ai';

import type { FastAgentTurnSource } from './fast-agent-conversation';

function substantiveHumanMessageText(
  message: ModelMessage,
): string | undefined {
  if (message.role !== 'user') return undefined;
  const metadata = (message as { metadata?: unknown }).metadata;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    (metadata as Record<string, unknown>).turnSource !== 'human'
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
