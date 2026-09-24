import { boundIntegrationToolReadContent } from '@roomote/types';

import type { FastAgentTurnSource } from './fast-agent-conversation';

const MAX_SESSION_USER_MESSAGES = 8;
const MAX_SESSION_USER_MESSAGE_LENGTH = 1_500;
const MAX_SESSION_USER_CONTEXT_LENGTH = 6_000;

/**
 * `priorHumanMessages` must come from canonical UserPrompt event rows filtered
 * by their server-stamped metadata. The N-1 compatibility mirror has no such
 * provenance and is not a valid source for approval context.
 */
export function resolveFastAgentToolApprovalSessionUserMessages(input: {
  turnSource: FastAgentTurnSource;
  substantiveHumanInput: boolean;
  question: string;
  priorHumanMessages: readonly string[];
  steeredHumanRequests: string[];
}): string[] {
  const history = input.priorHumanMessages.slice(-80);
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
  priorHumanMessages: readonly string[];
  steeredHumanRequests: string[];
}): string | undefined {
  if (input.turnSource === 'platform_event') {
    // Platform event text is not a human request. Use the newest prior prompt
    // selected from the canonical event log, plus any live human steers.
    const latestHumanRequest = input.priorHumanMessages.at(-1);
    return joinRequests([
      latestHumanRequest
        ? boundIntegrationToolReadContent(latestHumanRequest)
        : undefined,
      ...input.steeredHumanRequests,
    ]);
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
