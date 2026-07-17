import {
  classifyFollowUp,
  routeTask,
  type RoutingContext,
  type RoutingDecision,
  type RoutingWorkspace,
} from '@roomote/cloud-agents/server';

type RoutingSuggestion = {
  workspace: RoutingWorkspace;
  workspaceDisplayName: string;
};

type RoutingFollowUpResolution =
  | { intent: 'confirm' }
  | { intent: 'cancel' }
  | { intent: 'correct'; routingDecision: RoutingDecision };

function workspaceValue(workspace: RoutingWorkspace): string {
  return workspace.type === 'environment' ? workspace.id : 'all_repositories';
}

/**
 * Apply the same conversational routing semantics used by Slack to another
 * communication surface. The follow-up changes only the routing input; the
 * caller keeps the original queued message as the task that will launch.
 */
export async function resolveRoutingFollowUp(input: {
  routingContext: RoutingContext;
  suggestion: RoutingSuggestion | null;
  userResponse: string;
  userName: string;
  userId: string;
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

  const previousMessages =
    'threadMessages' in input.routingContext.source
      ? input.routingContext.source.threadMessages
      : undefined;
  const source =
    'threadMessages' in input.routingContext.source
      ? {
          ...input.routingContext.source,
          threadMessages: [
            ...(previousMessages ?? []),
            { user: input.userName, text: input.userResponse },
          ].slice(-5),
        }
      : input.routingContext.source;
  const routingContext: RoutingContext = {
    ...input.routingContext,
    // Match Slack: the correction is the primary routing instruction while
    // the original request remains available in the conversation context.
    taskDescription: input.userResponse,
    source,
    ...(input.suggestion
      ? {
          previousSuggestion: {
            workspaceValue: workspaceValue(input.suggestion.workspace),
            workspaceDisplayName: input.suggestion.workspaceDisplayName,
          },
        }
      : {}),
  };

  return {
    intent: 'correct',
    routingDecision: await routeTask(routingContext),
  };
}
