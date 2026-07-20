import {
  buildSuggestedTasksPrompt,
  enqueueTask,
} from '@roomote/cloud-agents/server';
import { db, recordAutomationRunOutcome } from '@roomote/db/server';
import { ALL_REPOSITORIES, TaskPayloadKind } from '@roomote/types';
import type { WorkItemStatus } from '@roomote/types';

import {
  formatSlackChannelName,
  type SuggesterDeploymentContext,
  type SuggestionDispatchPlan,
  type SuggestionDispatchRoute,
} from './suggester-route-planner';

const LOG_PREFIX = '[suggester]';

type EnvironmentBackedRepositoryCoverage = Array<{
  repositoryFullName: string;
  targetEnvironmentId: string;
}>;

async function enqueueSuggestionRoute(params: {
  deployment: SuggesterDeploymentContext;
  previousSuggestions: Array<{
    title: string;
    brief: string;
    status: WorkItemStatus;
  }>;
  repositoryCoverage: EnvironmentBackedRepositoryCoverage;
  repositoryFullNames: string[];
  route: SuggestionDispatchRoute;
  triggerKind: 'manual' | 'scheduled';
  destinationPayloadFields?: Record<string, string>;
}): Promise<{ error?: string; success: boolean; taskId?: string }> {
  try {
    // Suggestion scans run as the deployment service principal.
    const launchResult = await enqueueTask({
      task: {
        type: TaskPayloadKind.Scan,
        payload: {
          repo: ALL_REPOSITORIES,
          selectedRepositories: params.repositoryFullNames,
          ...(params.deployment.slackTeamId
            ? { teamId: params.deployment.slackTeamId }
            : {}),
          description: buildSuggestedTasksPrompt({
            repositoryFullNames: params.repositoryFullNames,
            repositoryCoverage: params.repositoryCoverage,
            routeContext: params.route.routeInstructions
              ? {
                  destinationChannelName: params.route.channelName,
                  excludedGroupLabels: params.route.excludedGroupLabels,
                  groupLabel:
                    params.route.groupLabel ??
                    formatSlackChannelName(null, params.route.channelId),
                  isFallbackRoute: params.route.isFallbackRoute,
                  routeInstructions: params.route.routeInstructions,
                }
              : null,
            setupGuidance: null,
            suggesterInstructions: params.route.suggesterInstructions,
            previousSuggestions: params.previousSuggestions,
            recentThreadFeedback: params.route.recentThreadFeedback,
          }),
          trigger: 'scheduled',
          notifySlack: true,
          slackChannel: params.route.channelId,
          suggestionSource: 'suggest_ideas',
          visibleInTranscript: false,
          ...(params.destinationPayloadFields ?? {}),
        },
      },
      initiator: { kind: 'automation', key: 'suggester' },
      workflow: 'scan',
      surface: 'system',
      trigger: params.triggerKind === 'manual' ? 'manual' : 'schedule',
      visibility: 'hidden',
      channels: { slackChannelId: params.route.channelId },
    });

    return { success: true, taskId: launchResult.taskId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      error: message,
    };
  }
}

export async function dispatchSuggestionRoutes(params: {
  deployment: SuggesterDeploymentContext;
  previousSuggestions: Array<{
    title: string;
    brief: string;
    status: WorkItemStatus;
  }>;
  repositoryCoverage: EnvironmentBackedRepositoryCoverage;
  repositoryFullNames: string[];
  routePlan: SuggestionDispatchPlan;
  triggerKind: 'manual' | 'scheduled';
  destinationPayloadFields?: Record<string, string>;
}): Promise<{
  errors: string[];
  firstLaunchedTaskId: string | null;
  successfulRoutes: number;
}> {
  let successfulRoutes = 0;
  let firstLaunchedTaskId: string | null = null;
  const errors: string[] = [];

  for (const route of params.routePlan.routes) {
    const result = await enqueueSuggestionRoute({
      deployment: params.deployment,
      previousSuggestions: params.previousSuggestions,
      repositoryCoverage: params.repositoryCoverage,
      repositoryFullNames: params.repositoryFullNames,
      route: {
        ...route,
        recentThreadFeedback:
          route.recentThreadFeedback ??
          (await params.routePlan.loadRecentThreadFeedbackForChannel(
            route.channelId,
          )),
      },
      triggerKind: params.triggerKind,
      destinationPayloadFields: params.destinationPayloadFields,
    });

    if (result.success) {
      successfulRoutes++;
      firstLaunchedTaskId ??= result.taskId ?? null;
      continue;
    }

    if (!result.error) {
      continue;
    }

    const routeLabel = route.groupLabel ?? route.channelId;
    errors.push(`${routeLabel}: ${result.error}`);
    console.error(`${LOG_PREFIX} Failed route ${routeLabel}: ${result.error}`);
  }

  // A pass with at least one successful route counts as a run; a pass where
  // every route failed lands the error on the automation row.
  if (successfulRoutes > 0) {
    await recordAutomationRunOutcome(db, {
      key: 'suggester',
      status: 'succeeded',
      at: new Date(),
    });
  } else if (errors.length > 0) {
    await recordAutomationRunOutcome(db, {
      key: 'suggester',
      status: 'failed',
      at: new Date(),
      error: errors.join('; '),
    });
  }

  return { errors, firstLaunchedTaskId, successfulRoutes };
}
