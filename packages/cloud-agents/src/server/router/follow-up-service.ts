import { recordUserRoutingPreference } from '@roomote/db/server';

import { classifyFollowUp, routeTask } from './router-service';
import { MAX_THREAD_MESSAGES } from './types';
import type { RoutingContext, RoutingDecision } from './types';

function getSuggestedEnvironmentId(
  suggestion: RoutingContext['previousSuggestion'] | null,
): string | null {
  const value = suggestion?.workspaceValue;

  if (!value) {
    return null;
  }

  return value.startsWith('env:') ? value.slice('env:'.length) : value;
}

type RoutingFollowUpResolution =
  | { intent: 'confirm' }
  | { intent: 'cancel' }
  | { intent: 'correct'; routingDecision: RoutingDecision };

/**
 * Resolve a reply to a pending routing suggestion for every chat surface.
 * The expensive correction context is lazy because confirms and cancels do
 * not need another routing pass.
 */
export async function resolveRoutingFollowUp(input: {
  suggestion: RoutingContext['previousSuggestion'] | null;
  userResponse: string;
  userId?: string | null;
  correctionMessage?: { user: string; text: string };
  buildCorrectionContext: () => Promise<RoutingContext>;
}): Promise<RoutingFollowUpResolution> {
  const classification = await classifyFollowUp({
    suggestedWorkspace:
      input.suggestion?.workspaceDisplayName ?? 'the workspace picker',
    userResponse: input.userResponse,
    userId: input.userId,
  });

  if (classification.intent === 'cancel') {
    return { intent: 'cancel' };
  }

  // A picker has no proposed choice to affirm. Treat an apparent confirmation
  // as a correction so the router can interpret the reply safely.
  if (classification.intent === 'confirm' && input.suggestion) {
    return { intent: 'confirm' };
  }

  let baseContext: RoutingContext;
  try {
    baseContext = await input.buildCorrectionContext();
  } catch (error) {
    return {
      intent: 'correct',
      routingDecision: {
        status: 'fallback',
        reason: `Could not build routing correction context: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const previousMessages =
    input.correctionMessage && 'threadMessages' in baseContext.source
      ? baseContext.source.threadMessages
      : undefined;
  const source =
    input.correctionMessage && 'threadMessages' in baseContext.source
      ? {
          ...baseContext.source,
          threadMessages: [
            ...(previousMessages ?? []),
            input.correctionMessage,
          ].slice(-MAX_THREAD_MESSAGES),
        }
      : baseContext.source;
  const routingContext: RoutingContext = {
    ...baseContext,
    source,
    ...(input.suggestion ? { previousSuggestion: input.suggestion } : {}),
  };

  const routingDecision = await routeTask(routingContext);
  const suggestedEnvironmentId = getSuggestedEnvironmentId(input.suggestion);

  if (
    routingDecision.status === 'routed' &&
    routingDecision.result.workspace.type === 'environment' &&
    !classification.isFallback &&
    input.userId &&
    suggestedEnvironmentId !== routingDecision.result.workspace.id
  ) {
    try {
      await recordUserRoutingPreference({
        userId: input.userId,
        environmentId: routingDecision.result.workspace.id,
      });
    } catch (error) {
      console.warn(
        `[RoutingCorrection] Failed to record user routing preference: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    intent: 'correct',
    routingDecision,
  };
}
