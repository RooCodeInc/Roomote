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
    for (
      let index = input.compatibilityMessages.length - 1;
      index >= 0;
      index -= 1
    ) {
      const text = substantiveHumanMessageText(
        input.compatibilityMessages[index]!,
      );
      if (text) return text;
    }
    return undefined;
  }

  if (!input.substantiveHumanInput) return undefined;
  const requests = [input.question, ...input.steeredHumanRequests]
    .map((request) => request.trim())
    .filter(Boolean);
  return requests.length > 0 ? requests.join('\n\n') : undefined;
}
