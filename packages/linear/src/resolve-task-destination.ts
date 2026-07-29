import {
  buildLinearRoutingContext,
  routeTask,
  type RoutingDebugInfo,
} from '@roomote/cloud-agents/server';
import { ALL_REPOSITORIES } from '@roomote/types';

import {
  deletePendingSelection,
  startElicitationFallback,
  stripEmojiPrefix,
} from './elicitation-fallback';
import type { LinearClient } from './linear-client';
import type { AgentSessionEventPayload } from './types';

export type LinearWorkspaceSelection = {
  repo?: string;
  environmentId?: string;
};

export type ResolvedLinearTaskDestination = {
  workspaceSelection: LinearWorkspaceSelection;
  workspaceDisplayName: string;
  workspaceType: 'environment' | 'all_repositories';
  kickoffMessage?: string;
  reasoning?: string;
  routingDebug?: RoutingDebugInfo;
  routingDurationMs?: number;
  userRoute?: string;
};

export type ResolveLinearTaskDestinationResult =
  | { status: 'routed'; destination: ResolvedLinearTaskDestination }
  | { status: 'platform_answer'; answer: string }
  | { status: 'awaiting_selection' }
  | { status: 'error'; message: string };

export async function resolveLinearTaskDestination({
  payload,
  agentSession,
  userId,
  linearClient,
  apiBaseUrl,
}: {
  payload: AgentSessionEventPayload;
  agentSession: AgentSessionEventPayload['agentSession'];
  userId?: string;
  linearClient: LinearClient;
  apiBaseUrl: string;
}): Promise<ResolveLinearTaskDestinationResult> {
  try {
    const taskDescription =
      agentSession.comment?.body ||
      agentSession.issue.description ||
      agentSession.issue.title;
    const routingContext = await buildLinearRoutingContext({
      userId,
      taskDescription,
      issueIdentifier: agentSession.issue.identifier,
      issueTitle: agentSession.issue.title,
      issueDescription: agentSession.issue.description,
      projectName: agentSession.issue.project?.name,
      teamName: agentSession.issue.team?.name,
      guidance: agentSession.guidance,
      previousComments: agentSession.previousComments?.map((comment) => ({
        body: comment.body,
        username: comment.user?.name,
      })),
      apiBaseUrl,
    });
    const routingStart = Date.now();
    const routingDecision = await routeTask(routingContext);
    const routingDurationMs = Date.now() - routingStart;

    if (routingDecision.status === 'platform_answer') {
      return {
        status: 'platform_answer',
        answer: routingDecision.result.answer,
      };
    }

    if (routingDecision.status === 'routed') {
      const { result } = routingDecision;

      if (result.workspace.type === 'environment') {
        return {
          status: 'routed',
          destination: {
            workspaceSelection: { environmentId: result.workspace.id },
            workspaceDisplayName: result.workspace.name,
            workspaceType: 'environment',
            ...(result.kickoffMessage
              ? { kickoffMessage: result.kickoffMessage }
              : {}),
            reasoning: result.reasoning,
            routingDebug: result.debug,
            routingDurationMs,
          },
        };
      }

      return {
        status: 'routed',
        destination: {
          workspaceSelection: { repo: ALL_REPOSITORIES },
          workspaceDisplayName: 'all repos',
          workspaceType: 'all_repositories',
          ...(result.kickoffMessage
            ? { kickoffMessage: result.kickoffMessage }
            : {}),
          reasoning: result.reasoning,
          routingDebug: result.debug,
          routingDurationMs,
        },
      };
    }

    console.log(
      `[LinearRouting] LLM routing fell back: ${routingDecision.reason}`,
    );
  } catch (error) {
    console.error(
      '[LinearRouting] LLM routing error, falling back to workspace selection:',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!userId) {
    return {
      status: 'routed',
      destination: {
        workspaceSelection: { repo: ALL_REPOSITORIES },
        workspaceDisplayName: 'all repos',
        workspaceType: 'all_repositories',
      },
    };
  }

  const sessionId = payload.agentSession.id;
  const fallbackResult = await startElicitationFallback({
    sessionId,
    linearOrganizationId: payload.organizationId,
    userId,
    payload,
    linearClient,
  });

  if (fallbackResult.status === 'error') {
    return fallbackResult;
  }

  if (fallbackResult.pendingSelection.step !== 'completed') {
    return { status: 'awaiting_selection' };
  }

  const selectedWorkspaceId =
    fallbackResult.pendingSelection.selectedRepo ?? ALL_REPOSITORIES;
  const workspaceOptions = fallbackResult.pendingSelection
    .workspaceOptions as Array<{
    type: 'all' | 'environment';
    id: string;
    name: string;
  }> | null;
  const selectedWorkspace = workspaceOptions?.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );

  await deletePendingSelection(sessionId);

  if (selectedWorkspace?.type === 'environment') {
    return {
      status: 'routed',
      destination: {
        workspaceSelection: { environmentId: selectedWorkspace.id },
        workspaceDisplayName: stripEmojiPrefix(selectedWorkspace.name),
        workspaceType: 'environment',
        userRoute: selectedWorkspace.name,
      },
    };
  }

  return {
    status: 'routed',
    destination: {
      workspaceSelection: { repo: ALL_REPOSITORIES },
      workspaceDisplayName: 'all repos',
      workspaceType: 'all_repositories',
      userRoute: selectedWorkspace?.name,
    },
  };
}
